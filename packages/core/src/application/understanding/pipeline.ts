/**
 * AI understanding of a snapshot: bottom-up summaries (symbols → files →
 * modules), feature map, one card per feature. Everything it produces goes to
 * the `rag` schema through `KnowledgeRepository`.
 *
 * Phases are idempotent and resumable: `prepare` clears the previous output;
 * the summary and card phases skip what is already stored, so a retried job
 * does not pay twice for the same model calls.
 */
import { CARD } from "../prompts/card.ts"
import {
  FEATURE_MAP,
  FEATURE_MERGE,
  FEATURE_UPDATE,
  FeatureMapOutput,
  featureMapInstructions,
  FeatureMergeOutput,
  featureMergeInstructions,
  featureUpdateInstructions,
  renderFeatureMap,
  renderFeatureMapFile,
  renderFeatureMerge,
  renderFeatureUpdate
} from "../prompts/features.ts"
import { estimateTokens } from "../prompts/format.ts"
import {
  FILE_ROLLUP,
  FILE_SUMMARY,
  fileRollupInstructions,
  FileSummaryOutput,
  fileSummaryInstructions,
  MODULE_SUMMARY,
  moduleSummaryInstructions,
  renderFileRollup,
  renderFileSummary,
  renderModuleSummary,
  RollupOutput,
  type SymbolLine
} from "../prompts/summaries.ts"
import { FEATURE_TRIAGE, renderFeatureTriage, USER_FACING_QUESTION, userFacingQuestion } from "../prompts/triage.ts"
import { CARD_VERIFY } from "../prompts/verify.ts"
import { DecisionModel, EmbeddingModel, LanguageModel } from "../../ports/outbound/models.ts"
import { Effect } from "effect"
import { AppConfig } from "../config.ts"
import { type CardStatus, type FeatureEntry, type Job, JobId, type SnapshotId } from "../../domain/model.ts"
import { InvalidInputError, PhaseError } from "../../domain/errors.ts"
import type { PhaseContext, Pipeline } from "../pipeline.ts"
import { requestIndexing } from "../rag/indexing.ts"
import {
  type Declaration,
  EvaluationRepository,
  type FileForUnderstanding,
  JobRepository,
  KnowledgeRepository,
  type NewFeature,
  type NewFileSummary,
  ProjectRepository,
  SnapshotRepository,
  UnderstandingRepository
} from "../../ports/outbound/repositories.ts"
import { UploadStore } from "../../ports/outbound/source.ts"
import { ensureNotUpdating, promoteSnapshot } from "../updates.ts"
import { featureKey } from "../../domain/features.ts"
import { dedupeFeatures, mergeFeatures, normalizeFeatures } from "./features.ts"
import { planModules } from "./modules.ts"
import { splitIntoParts } from "./parts.ts"
import { loadCardSources, verificationModel, verifyCard, writeCard } from "./cards.ts"
import { selectFiles } from "./select.ts"
import { chunks, groupBy, inputBudget, provenance, skipInvalid, toPhaseError } from "./shared.ts"
import {
  applyFeatureUpdate,
  carryFeatures,
  changedPaths,
  diffFiles,
  dirtyModules,
  featureAffected,
  featureChangedFiles,
  type FileChanges
} from "./update.ts"

/** Summaries and cards are always written in English. */
export const UNDERSTANDING_LANGUAGE = "en"

/** Files loaded and summarized together (the model's own concurrency limit still applies). */
const FILE_BATCH_SIZE = 8
const CARD_BATCH_SIZE = 4
/** Declarations listed in a file prompt and per file in the feature map. */
const MAX_FILE_DECLARATIONS = 80
const MAX_FEATURE_MAP_DECLARATIONS = 6

type Progress = PhaseContext["progress"]

/** Review states a reviewer must confirm again when the card is rewritten for new code. */
const REVIEWED: ReadonlySet<CardStatus> = new Set(["approved", "in_review", "needs_recheck"])

interface UpdateBase {
  readonly baseId: SnapshotId
  readonly changes: FileChanges
  readonly changed: ReadonlySet<string>
}

/**
 * Incremental update (phase 6): the previous version and the file changes,
 * from the job payload; undefined for a full understanding.
 */
const updateBase = Effect.fnUntraced(function* (job: Job) {
  const payload = job.payload
  if (payload === null || !("baseSnapshotId" in payload)) return undefined
  const snapshots = yield* SnapshotRepository
  const [before, after] = yield* Effect.all([
    snapshots.fileHashes(payload.baseSnapshotId),
    snapshots.fileHashes(job.snapshotId)
  ])
  const changes = diffFiles(before, after)
  return { baseId: payload.baseSnapshotId, changes, changed: changedPaths(changes) } satisfies UpdateBase
})

// ---------------------------------------------------------------------------
// prepare

const prepare = Effect.fn("understanding.prepare")(
  function* (job: Job) {
    const understanding = yield* UnderstandingRepository
    const knowledge = yield* KnowledgeRepository
    const model = yield* LanguageModel
    if (model.modelId === undefined) {
      return yield* new PhaseError({
        phase: "prepare",
        message: "Modello IA non configurato (AI_MODEL)",
        retryable: false
      })
    }
    yield* understanding.setStatus(job.snapshotId, "running")
    const info = yield* understanding.snapshotInfo(job.snapshotId)
    yield* knowledge.reset(info, { language: UNDERSTANDING_LANGUAGE, model: model.modelId })
    // Incremental update: files with the same content keep their summary (same model and prompt only).
    const base = yield* updateBase(job)
    if (base !== undefined) {
      yield* knowledge.copyFileSummaries(
        job.snapshotId,
        base.baseId,
        base.changes.unchanged,
        provenance(model, FILE_SUMMARY)
      )
    }
  },
  (effect) => effect.pipe(Effect.mapError(toPhaseError("prepare")))
)

// ---------------------------------------------------------------------------
// summarize-files

const fileDeclarations = (declarations: ReadonlyArray<Declaration>): Array<SymbolLine> =>
  declarations
    .slice()
    .sort((a, b) => a.startLine - b.startLine)
    .slice(0, MAX_FILE_DECLARATIONS)
    .map((d) => ({ kind: d.kind, qualifiedName: d.qualifiedName, startLine: d.startLine, endLine: d.endLine }))

const summarizeFile = Effect.fnUntraced(function* (
  job: Job,
  file: FileForUnderstanding,
  declarations: ReadonlyArray<Declaration>
) {
  const model = yield* LanguageModel
  const context = { phase: "summarize-files", jobId: job.id, snapshotId: job.snapshotId }
  const lines = file.content.split("\n")
  const listed = fileDeclarations(declarations)
  const overhead = estimateTokens(
    renderFileSummary({
      path: file.path,
      language: file.language,
      totalLines: lines.length,
      lines: [],
      firstLine: 1,
      symbols: listed
    })
  )
  const codeBudget = Math.max(256, inputBudget(model, fileSummaryInstructions) - overhead)
  const topLevel = declarations.filter((d) => d.container === null).map((d) => d.startLine)
  const parts = splitIntoParts(lines, topLevel, codeBudget)

  const answers = yield* Effect.forEach(parts, (part) => {
    const lastLine = part.firstLine + part.lines.length - 1
    return model
      .generateObject({
        prompt: FILE_SUMMARY,
        context,
        instructions: fileSummaryInstructions,
        input: renderFileSummary({
          path: file.path,
          language: file.language,
          totalLines: lines.length,
          lines: part.lines,
          firstLine: part.firstLine,
          symbols: listed.filter((s) => s.startLine >= part.firstLine && s.startLine <= lastLine)
        }),
        schema: FileSummaryOutput
      })
      .pipe(Effect.map((answer) => ({ part, lastLine, answer })))
  })

  let summary = answers[0]?.answer.summary ?? ""
  if (answers.length > 1) {
    const rollup = yield* model.generateObject({
      prompt: FILE_ROLLUP,
      context,
      instructions: fileRollupInstructions,
      input: renderFileRollup({
        path: file.path,
        parts: answers.map((a) => ({ firstLine: a.part.firstLine, lastLine: a.lastLine, summary: a.answer.summary }))
      }),
      schema: RollupOutput
    })
    summary = rollup.summary
  }

  // Symbol summaries are kept only for declarations that exist (matched by qualified name).
  const byName = new Map(declarations.map((d) => [d.qualifiedName, d]))
  const symbols = new Map<string, NewFileSummary["symbols"][number]>()
  for (const { answer } of answers) {
    for (const entry of answer.symbols) {
      const declaration = byName.get(entry.name.trim())
      if (declaration === undefined || symbols.has(declaration.qualifiedName)) continue
      symbols.set(declaration.qualifiedName, {
        qualifiedName: declaration.qualifiedName,
        kind: declaration.kind,
        startLine: declaration.startLine,
        endLine: declaration.endLine,
        summary: entry.summary.trim()
      })
    }
  }
  return {
    path: file.path,
    language: file.language,
    contentHash: file.contentHash,
    summary: summary.trim(),
    parts: parts.length,
    symbols: [...symbols.values()]
  } satisfies NewFileSummary
})

const summarizeFiles = Effect.fn("understanding.summarizeFiles")(
  function* (job: Job, progress: Progress) {
    const snapshots = yield* SnapshotRepository
    const understanding = yield* UnderstandingRepository
    const knowledge = yield* KnowledgeRepository
    const model = yield* LanguageModel

    const files = selectFiles(yield* snapshots.listFiles(job.snapshotId))
    const done = new Set((yield* knowledge.fileSummaries(job.snapshotId)).map((s) => s.path))
    const pending = files.filter((file) => !done.has(file.path))
    const declarations = groupBy(yield* understanding.declarations(job.snapshotId), (d) => d.path)

    let completed = done.size
    let skipped = 0
    const report = () =>
      progress({
        completed,
        total: files.length,
        message: `${completed} di ${files.length} file riassunti${skipped > 0 ? ` (${skipped} saltati)` : ""}`
      })
    yield* report()
    for (const batch of chunks(pending, FILE_BATCH_SIZE)) {
      const loaded = yield* understanding.loadFiles(
        job.snapshotId,
        batch.map((file) => file.path)
      )
      yield* Effect.forEach(
        loaded,
        (file) =>
          skipInvalid(summarizeFile(job, file, declarations.get(file.path) ?? []), () => skipped++).pipe(
            Effect.flatMap((summary) =>
              summary === undefined
                ? Effect.void
                : knowledge.saveFileSummary(job.snapshotId, summary, provenance(model, FILE_SUMMARY))
            ),
            Effect.tap(() => Effect.sync(() => completed++))
          ),
        { concurrency: "unbounded", discard: true }
      )
      yield* report()
    }
    if (files.length > 0 && skipped === files.length) {
      return yield* new PhaseError({
        phase: "summarize-files",
        message: "Il modello non ha prodotto riassunti validi per nessun file",
        retryable: false
      })
    }
  },
  (effect) => effect.pipe(Effect.mapError(toPhaseError("summarize-files")))
)

// ---------------------------------------------------------------------------
// summarize-modules

/** Fits a module prompt in the budget by shortening the listed summaries, then the list. */
const fitModuleInput = (render: (maxChars: number, maxItems: number) => string, budget: number): string => {
  for (const maxChars of [600, 300, 160, 80]) {
    const input = render(maxChars, Number.MAX_SAFE_INTEGER)
    if (estimateTokens(input) <= budget) return input
  }
  let maxItems = 200
  let input = render(80, maxItems)
  while (estimateTokens(input) > budget && maxItems > 5) {
    maxItems = Math.floor(maxItems / 2)
    input = render(80, maxItems)
  }
  return input
}

const summarizeModules = Effect.fn("understanding.summarizeModules")(
  function* (job: Job, progress: Progress) {
    const knowledge = yield* KnowledgeRepository
    const model = yield* LanguageModel
    const fileSummaries = new Map((yield* knowledge.fileSummaries(job.snapshotId)).map((s) => [s.path, s.summary]))
    const plan = planModules([...fileSummaries.keys()])
    // Incremental update: modules with no changed file in their subtree keep their summary.
    const base = yield* updateBase(job)
    if (base !== undefined) {
      const dirty = dirtyModules(base.changed)
      yield* knowledge.copyModuleSummaries(
        job.snapshotId,
        base.baseId,
        plan.filter((module) => !dirty.has(module.path)).map((module) => module.path),
        provenance(model, MODULE_SUMMARY)
      )
    }
    const moduleSummaries = new Map((yield* knowledge.moduleSummaries(job.snapshotId)).map((s) => [s.path, s.summary]))
    const budget = inputBudget(model, moduleSummaryInstructions)
    let skipped = 0

    let completed = 0
    for (const module of plan) {
      completed++
      if (moduleSummaries.has(module.path)) continue
      const shorten = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)
      const input = fitModuleInput(
        (maxChars, maxItems) =>
          renderModuleSummary({
            path: module.path,
            files: module.files
              .slice(0, maxItems)
              .map((path) => ({ path, summary: shorten(fileSummaries.get(path) ?? "", maxChars) })),
            modules: module.modules
              .slice(0, maxItems)
              .map((path) => ({ path, summary: shorten(moduleSummaries.get(path) ?? "", maxChars) }))
          }),
        budget
      )
      const answer = yield* skipInvalid(
        model.generateObject({
          prompt: MODULE_SUMMARY,
          context: { phase: "summarize-modules", jobId: job.id, snapshotId: job.snapshotId },
          instructions: moduleSummaryInstructions,
          input,
          schema: RollupOutput
        }),
        () => skipped++
      )
      if (answer !== undefined) {
        const summary = answer.summary.trim()
        moduleSummaries.set(module.path, summary)
        yield* knowledge.saveModuleSummary(
          job.snapshotId,
          { path: module.path, depth: module.depth, summary, fileCount: module.fileCount },
          provenance(model, MODULE_SUMMARY)
        )
      }
      yield* progress({
        completed,
        total: plan.length,
        message: `${completed} di ${plan.length} moduli riassunti${skipped > 0 ? ` (${skipped} saltati)` : ""}`
      })
    }
  },
  (effect) => effect.pipe(Effect.mapError(toPhaseError("summarize-modules")))
)

// ---------------------------------------------------------------------------
// map-features

/** Existing features listed in the update prompt: descriptions are shortened (then left out) to fit the budget. */
const fitFeatureList = (
  features: ReadonlyArray<{ readonly name: string; readonly description: string }>,
  budget: number
): Array<{ readonly name: string; readonly description: string }> => {
  const shorten = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)
  for (const maxChars of [240, 120, 60, 0]) {
    const listed = features.map((f) => ({ name: f.name, description: shorten(f.description, maxChars) }))
    if (estimateTokens(listed.map((f) => `- ${f.name}: ${f.description}`).join("\n")) <= budget) return listed
  }
  return features.map((f) => ({ name: f.name, description: "" }))
}

/**
 * Incremental feature map: the features of the previous version are carried
 * over (without deleted files and declarations); new and modified files are
 * attached to them or form new features.
 */
const updateFeatures = Effect.fnUntraced(function* (job: Job, progress: Progress, base: UpdateBase) {
  const understanding = yield* UnderstandingRepository
  const knowledge = yield* KnowledgeRepository
  const model = yield* LanguageModel
  const context = { phase: "map-features", jobId: job.id, snapshotId: job.snapshotId }

  const fileSummaries = yield* knowledge.fileSummaries(job.snapshotId)
  const declarations = yield* understanding.declarations(job.snapshotId)
  const known = { files: new Set(fileSummaries.map((f) => f.path)), declarations }
  const previous = yield* knowledge.featureMap(base.baseId)
  const carried = carryFeatures(previous.features, known)
  const projectSummary = (yield* knowledge.moduleSummaries(job.snapshotId)).find((m) => m.path === "")?.summary ?? null

  const touched = new Set([...base.changes.added, ...base.changes.modified])
  const declarationsByPath = groupBy(declarations, (d) => d.path)
  const fileLines = fileSummaries
    .filter((file) => touched.has(file.path))
    .map((file) =>
      renderFeatureMapFile({
        path: file.path,
        summary: file.summary,
        symbols: (declarationsByPath.get(file.path) ?? [])
          .filter((d) => d.container === null && d.exported)
          .slice(0, MAX_FEATURE_MAP_DECLARATIONS)
          .map((d) => d.qualifiedName)
      })
    )

  const proposed: Array<NewFeature> = []
  let skipped = 0
  if (fileLines.length > 0) {
    // The existing features take at most half of the budget; the files are batched in the rest.
    const budget = inputBudget(model, featureUpdateInstructions)
    const listed = fitFeatureList(carried, Math.floor(budget / 2))
    const overhead = estimateTokens(renderFeatureUpdate({ projectSummary, features: listed, files: [] }))
    const fileBudget = Math.max(512, budget - overhead)
    const batches: Array<Array<string>> = [[]]
    let used = 0
    for (const line of fileLines) {
      const cost = estimateTokens(line) + 1
      const current = batches.at(-1) as Array<string>
      if (current.length > 0 && used + cost > fileBudget) {
        batches.push([line])
        used = cost
      } else {
        current.push(line)
        used += cost
      }
    }
    let index = 0
    for (const files of batches) {
      index++
      const answer = yield* skipInvalid(
        model.generateObject({
          prompt: FEATURE_UPDATE,
          context,
          instructions: featureUpdateInstructions,
          input: renderFeatureUpdate({ projectSummary, features: listed, files }),
          schema: FeatureMapOutput
        }),
        () => skipped++
      )
      if (answer !== undefined) proposed.push(...normalizeFeatures(answer.features, known))
      yield* progress({
        completed: index,
        total: batches.length,
        message: `${index} di ${batches.length} gruppi di file nuovi o modificati assegnati`
      })
    }
  }

  const features = applyFeatureUpdate(carried, proposed)
  if (features.length === 0) {
    return yield* new PhaseError({
      phase: "map-features",
      message: "Nessuna funzionalità resta collegata ai file della nuova versione",
      retryable: false
    })
  }
  yield* knowledge.replaceFeatures(job.snapshotId, features, provenance(model, FEATURE_UPDATE))
  const info = yield* understanding.snapshotInfo(job.snapshotId)
  // Copied cards keep the corrections they applied.
  yield* knowledge.reattachCorrections(job.snapshotId, info.projectId, { keepApplied: true })
  yield* (yield* EvaluationRepository).reattachQuestions(job.snapshotId, info.projectId)
  const added = features.length - carried.length
  const removed = previous.features.length - carried.length
  yield* progress({
    completed: 1,
    total: 1,
    message: `${features.length} funzionalità (${added} nuove, ${removed} rimosse)${skipped > 0 ? `, ${skipped} gruppi saltati` : ""}`
  })
})

const mapFeatures = Effect.fn("understanding.mapFeatures")(
  function* (job: Job, progress: Progress) {
    const understanding = yield* UnderstandingRepository
    const knowledge = yield* KnowledgeRepository
    const model = yield* LanguageModel
    const context = { phase: "map-features", jobId: job.id, snapshotId: job.snapshotId }
    const base = yield* updateBase(job)
    if (base !== undefined) return yield* updateFeatures(job, progress, base)

    const fileSummaries = yield* knowledge.fileSummaries(job.snapshotId)
    const modules = [...(yield* knowledge.moduleSummaries(job.snapshotId))].sort((a, b) => a.path.localeCompare(b.path))
    const declarations = yield* understanding.declarations(job.snapshotId)
    const projectSummary = modules.find((m) => m.path === "")?.summary ?? null

    const declarationsByPath = groupBy(declarations, (d) => d.path)
    const fileLines = [...fileSummaries]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((file) =>
        renderFeatureMapFile({
          path: file.path,
          summary: file.summary,
          symbols: (declarationsByPath.get(file.path) ?? [])
            .filter((d) => d.container === null && d.exported)
            .slice(0, MAX_FEATURE_MAP_DECLARATIONS)
            .map((d) => d.qualifiedName)
        })
      )

    // Module overview shared by every batch: deeper modules are dropped if it is too large.
    const budget = inputBudget(model, featureMapInstructions)
    let overview = modules.filter((m) => m.path !== "").map((m) => ({ path: m.path, summary: m.summary.slice(0, 300) }))
    const overviewCost = () =>
      estimateTokens(renderFeatureMap({ projectSummary, modules: overview, files: [], batch: { index: 1, count: 1 } }))
    for (let depth = 4; overviewCost() > budget / 2 && depth >= 1; depth--) {
      overview = overview.filter((m) => m.path.split("/").length <= depth)
    }
    const fileBudget = Math.max(512, budget - overviewCost())

    const batches: Array<Array<string>> = [[]]
    let used = 0
    for (const line of fileLines) {
      const cost = estimateTokens(line) + 1
      const current = batches.at(-1) as Array<string>
      if (current.length > 0 && used + cost > fileBudget) {
        batches.push([line])
        used = cost
      } else {
        current.push(line)
        used += cost
      }
    }

    const known = { files: new Set(fileSummaries.map((f) => f.path)), declarations }
    const candidates: Array<NewFeature> = []
    let index = 0
    for (const files of batches) {
      index++
      const answer = yield* model.generateObject({
        prompt: FEATURE_MAP,
        context,
        instructions: featureMapInstructions,
        input: renderFeatureMap({
          projectSummary,
          modules: overview,
          files,
          batch: batches.length > 1 ? { index, count: batches.length } : null
        }),
        schema: FeatureMapOutput
      })
      candidates.push(...normalizeFeatures(answer.features, known))
      yield* progress({ completed: index, total: batches.length, message: `${candidates.length} funzionalità trovate` })
    }

    let features = dedupeFeatures(candidates)
    if (batches.length > 1 && features.length > 1) {
      const merge = yield* skipInvalid(
        model.generateObject({
          prompt: FEATURE_MERGE,
          context,
          instructions: featureMergeInstructions,
          input: renderFeatureMerge(
            features.map((f) => ({ name: f.name, description: f.description, files: f.files.length }))
          ),
          schema: FeatureMergeOutput
        }),
        () => undefined
      )
      if (merge !== undefined) features = dedupeFeatures(mergeFeatures(features, merge))
    }
    if (features.length === 0) {
      return yield* new PhaseError({
        phase: "map-features",
        message: "Il modello non ha individuato funzionalità collegate ai file del progetto",
        retryable: false
      })
    }
    yield* knowledge.replaceFeatures(job.snapshotId, features, provenance(model, FEATURE_MAP))
    const info = yield* understanding.snapshotInfo(job.snapshotId)
    yield* knowledge.reattachCorrections(job.snapshotId, info.projectId)
    yield* (yield* EvaluationRepository).reattachQuestions(job.snapshotId, info.projectId)
    yield* progress({
      completed: batches.length,
      total: batches.length,
      message: `${features.length} funzionalità individuate`
    })
  },
  (effect) => effect.pipe(Effect.mapError(toPhaseError("map-features")))
)

// ---------------------------------------------------------------------------
// classify-features

const classifyFeatures = Effect.fn("understanding.classifyFeatures")(
  function* (job: Job, progress: Progress) {
    const knowledge = yield* KnowledgeRepository
    const decision = yield* DecisionModel
    const thresholds = (yield* AppConfig).triage
    const context = { phase: "classify-features", jobId: job.id, snapshotId: job.snapshotId }
    const { features } = yield* knowledge.featureMap(job.snapshotId)
    const previous = yield* previousCards(yield* updateBase(job))
    // Features that already have a card (a resumed job) are left as they are.
    const pending = features.filter((feature) => feature.card === null)

    let completed = 0
    let technical = 0
    const report = () =>
      progress({
        completed,
        total: pending.length,
        message: `${completed} di ${pending.length} funzionalità valutate${technical > 0 ? `, ${technical} solo tecniche (senza scheda)` : ""}`
      })
    yield* report()
    const triage: Array<{ featureId: string; userFacing: number | null; technical: boolean }> = []
    for (const feature of pending) {
      if (previous.has(featureKey(feature.name))) {
        // It had a card in the previous version (maybe asked for by a reviewer): it keeps one.
        triage.push({ featureId: feature.id, userFacing: null, technical: false })
      } else {
        const answer = yield* decision.decide({
          prompt: FEATURE_TRIAGE,
          context,
          state: renderFeatureTriage(feature),
          questions: { [USER_FACING_QUESTION]: userFacingQuestion }
        })
        const userFacing = answer[USER_FACING_QUESTION] ?? null
        const isTechnical = userFacing !== null && userFacing < thresholds.userFacing
        if (isTechnical) technical++
        triage.push({ featureId: feature.id, userFacing, technical: isTechnical })
      }
      completed++
      if (completed % 10 === 0) yield* report()
    }
    yield* knowledge.classifyFeatures(job.snapshotId, triage)
    yield* report()
  },
  (effect) => effect.pipe(Effect.mapError(toPhaseError("classify-features")))
)

// ---------------------------------------------------------------------------
// generate-cards

/** The card of the previous version for a feature, matched by name (like corrections and test questions). */
const previousCards = Effect.fnUntraced(function* (base: UpdateBase | undefined) {
  if (base === undefined) return new Map<string, FeatureEntry>()
  const knowledge = yield* KnowledgeRepository
  const { features } = yield* knowledge.featureMap(base.baseId)
  return new Map(features.flatMap((f) => (f.card === null ? [] : [[featureKey(f.name), f] as const])))
})

const generateCards = Effect.fn("understanding.generateCards")(
  function* (job: Job, progress: Progress) {
    const understanding = yield* UnderstandingRepository
    const knowledge = yield* KnowledgeRepository
    const model = yield* LanguageModel
    const context = { phase: "generate-cards", jobId: job.id, snapshotId: job.snapshotId }

    const info = yield* understanding.snapshotInfo(job.snapshotId)
    // Features the triage found only technical get no card (a reviewer can still ask for one).
    const features = (yield* knowledge.featureMap(job.snapshotId)).features.filter((feature) => !feature.technical)
    const pending = features.filter((feature) => feature.card === null)
    const sources = yield* loadCardSources(job.snapshotId)
    // Reviewer corrections survive regenerations: they go into the prompt of their feature's card.
    const corrections = groupBy(
      (yield* knowledge.corrections(job.snapshotId)).filter((c) => c.featureId !== null),
      (c) => c.featureId ?? ""
    )
    const base = yield* updateBase(job)
    const previous = yield* previousCards(base)

    let completed = features.length - pending.length
    let skipped = 0
    let kept = 0
    const report = () =>
      progress({
        completed,
        total: features.length,
        message: `${completed} di ${features.length} schede ${base === undefined ? "generate" : `pronte (${kept} invariate)`}${skipped > 0 ? ` (${skipped} saltate)` : ""}`
      })
    yield* report()

    for (const batch of chunks(pending, CARD_BATCH_SIZE)) {
      yield* Effect.forEach(
        batch,
        (feature) =>
          Effect.gen(function* () {
            const featureCorrections = corrections.get(feature.id) ?? []
            const before = previous.get(featureKey(feature.name))
            const baseCard =
              base === undefined || before?.card == null
                ? undefined
                : yield* knowledge.getCard(base.baseId, before.card.id)
            // Same files, same content (or excluded by a reviewer): the card is copied with its review and index.
            if (
              base !== undefined &&
              before !== undefined &&
              baseCard !== undefined &&
              (baseCard.status === "excluded" || !featureAffected(before, feature, base.changed))
            ) {
              yield* knowledge.copyCard(job.snapshotId, { cardId: baseCard.id, featureId: feature.id })
              kept++
              completed++
              return
            }
            const checked = yield* skipInvalid(
              writeCard(context, feature, sources, {
                current: baseCard?.content ?? null,
                corrections: featureCorrections.map((c) => c.text),
                changedFiles:
                  base === undefined || before === undefined
                    ? undefined
                    : featureChangedFiles(before, feature, base.changed)
              }),
              // Counted below: an answer still invalid and a feature with no file to show are both skipped.
              () => undefined
            )
            if (checked === undefined) {
              // An update that failed keeps the previous card, for a reviewer to check against the new code.
              if (baseCard !== undefined) {
                yield* knowledge.copyCard(job.snapshotId, {
                  cardId: baseCard.id,
                  featureId: feature.id,
                  status: "needs_recheck"
                })
                completed++
              } else {
                skipped++
              }
              return
            }
            const version = yield* knowledge.saveCard(
              job.snapshotId,
              {
                featureId: feature.id,
                // A reviewed card rewritten for new code waits for the reviewer again.
                status: baseCard !== undefined && REVIEWED.has(baseCard.status) ? "needs_recheck" : "generated",
                change: base === undefined ? undefined : baseCard === undefined ? "created" : "updated",
                baseVersion: baseCard?.version,
                content: checked.content,
                sourceRevision: info.revision,
                unreferencedStatements: checked.unreferencedStatements,
                references: checked.references
              },
              provenance(model, CARD)
            )
            if (featureCorrections.length > 0) {
              yield* knowledge.markCorrectionsApplied(
                featureCorrections.map((c) => c.id),
                version
              )
            }
            completed++
          }),
        { concurrency: "unbounded", discard: true }
      )
      yield* report()
    }
  },
  (effect) => effect.pipe(Effect.mapError(toPhaseError("generate-cards")))
)

// ---------------------------------------------------------------------------
// verify-cards

const verifyCards = Effect.fn("understanding.verifyCards")(
  function* (job: Job, progress: Progress) {
    const knowledge = yield* KnowledgeRepository
    const decision = yield* DecisionModel
    const model = yield* LanguageModel
    const context = { phase: "verify-cards", jobId: job.id, snapshotId: job.snapshotId }
    const pending = yield* knowledge.cardsToVerify(job.snapshotId)
    const sources = yield* loadCardSources(job.snapshotId)

    let completed = 0
    let skipped = 0
    let flagged = 0
    const report = () =>
      progress({
        completed,
        total: pending.length,
        message: `${completed} di ${pending.length} schede verificate${flagged > 0 ? `, ${flagged} da controllare` : ""}${skipped > 0 ? ` (${skipped} saltate)` : ""}`
      })
    yield* report()
    for (const batch of chunks(pending, CARD_BATCH_SIZE)) {
      yield* Effect.forEach(
        batch,
        (cardId) =>
          Effect.gen(function* () {
            const card = yield* knowledge.getCard(job.snapshotId, cardId)
            const verification = yield* skipInvalid(verifyCard(context, card.feature, sources, card), () => skipped++)
            completed++
            if (verification === undefined) return
            if (verification.issues > 0) flagged++
            yield* knowledge.saveVerification(
              job.snapshotId,
              cardId,
              verification,
              provenance(verificationModel(decision, model), CARD_VERIFY)
            )
          }),
        { concurrency: "unbounded", discard: true }
      )
      yield* report()
    }
  },
  (effect) => effect.pipe(Effect.mapError(toPhaseError("verify-cards")))
)

// ---------------------------------------------------------------------------
// finalize

const finalize = Effect.fn("understanding.finalize")(
  function* (job: Job) {
    const knowledge = yield* KnowledgeRepository
    const understanding = yield* UnderstandingRepository
    const counts = yield* knowledge.counts(job.snapshotId)
    yield* understanding.complete(job.snapshotId, counts)
    const base = yield* updateBase(job)
    if (base !== undefined) {
      const snapshots = yield* SnapshotRepository
      const info = yield* understanding.snapshotInfo(job.snapshotId)
      // Corrections and test questions written meanwhile on the previous version follow the features here.
      yield* knowledge.reattachCorrections(job.snapshotId, info.projectId, { keepApplied: true })
      yield* (yield* EvaluationRepository).reattachQuestions(job.snapshotId, info.projectId)
      const [cards, before, after] = yield* Effect.all([
        knowledge.changeCounts(job.snapshotId),
        knowledge.featureMap(base.baseId),
        knowledge.featureMap(job.snapshotId)
      ])
      const names = new Set(after.features.map((f) => featureKey(f.name)))
      yield* snapshots.saveChanges(job.snapshotId, {
        files: {
          added: base.changes.added.length,
          modified: base.changes.modified.length,
          removed: base.changes.removed.length
        },
        cards: { ...cards, removed: before.features.filter((f) => !names.has(featureKey(f.name))).length }
      })
      // The updated version replaces the previous one for pages, chat and tests.
      yield* promoteSnapshot(job.snapshotId)
    }
    // The new cards go into the chat's index (when embeddings are configured).
    yield* requestIndexing(job.snapshotId)
  },
  (effect) => effect.pipe(Effect.mapError(toPhaseError("finalize")))
)

export const understandingPipeline: Pipeline<
  | AppConfig
  | DecisionModel
  | EmbeddingModel
  | EvaluationRepository
  | JobRepository
  | KnowledgeRepository
  | LanguageModel
  | ProjectRepository
  | SnapshotRepository
  | UnderstandingRepository
  | UploadStore
> = {
  type: "understanding",
  phases: [
    { name: "prepare", run: ({ job }) => prepare(job) },
    { name: "summarize-files", run: ({ job, progress }) => summarizeFiles(job, progress) },
    { name: "summarize-modules", run: ({ job, progress }) => summarizeModules(job, progress) },
    { name: "map-features", run: ({ job, progress }) => mapFeatures(job, progress) },
    { name: "classify-features", run: ({ job, progress }) => classifyFeatures(job, progress) },
    { name: "generate-cards", run: ({ job, progress }) => generateCards(job, progress) },
    { name: "verify-cards", run: ({ job, progress }) => verifyCards(job, progress) },
    { name: "finalize", run: ({ job }) => finalize(job) }
  ],
  onFailed: (job) =>
    UnderstandingRepository.use((repository) => repository.setStatus(job.snapshotId, "failed")).pipe(Effect.ignore)
}

/**
 * Queues the AI understanding of a snapshot (manual action), or returns the job
 * already queued/running. Requires the static analysis to be complete.
 */
export const requestUnderstanding = Effect.fn("requestUnderstanding")(function* (snapshotId: SnapshotId) {
  const config = yield* AppConfig
  const jobs = yield* JobRepository
  const snapshots = yield* SnapshotRepository
  const understanding = yield* UnderstandingRepository
  const { snapshot } = yield* snapshots.get(snapshotId)
  if (snapshot.status !== "ready" || snapshot.analysisStatus !== "ready") {
    return yield* new InvalidInputError({ message: "L'analisi statica del progetto non è ancora completata" })
  }
  yield* ensureNotUpdating(snapshot.projectId)
  // A new feature map would replace the cards that card, question and test jobs are working on.
  const active = yield* jobs.active(snapshot.projectId)
  if (active.some((job) => job.type === "card" || job.type === "questions" || job.type === "evaluation")) {
    return yield* new InvalidInputError({ message: "Attendi la fine delle operazioni in corso sulle schede" })
  }
  const job = yield* jobs.enqueue({
    id: JobId.make(crypto.randomUUID()),
    type: "understanding",
    projectId: snapshot.projectId,
    snapshotId,
    maxAttempts: config.jobMaxAttempts
  })
  if (job.status === "queued") yield* understanding.setStatus(snapshotId, "pending")
  return job
})
