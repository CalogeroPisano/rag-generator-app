/**
 * AI understanding of a snapshot: bottom-up summaries (symbols → files →
 * modules), feature map, one card per feature. Everything it produces goes to
 * the `rag` schema through `KnowledgeRepository`.
 *
 * Phases are idempotent and resumable: `prepare` clears the previous output;
 * the summary and card phases skip what is already stored, so a retried job
 * does not pay twice for the same model calls.
 */
import {
  AiError,
  CARD,
  CardContent,
  cardInstructions,
  estimateTokens,
  FEATURE_MAP,
  FEATURE_MERGE,
  FeatureMapOutput,
  featureMapInstructions,
  FeatureMergeOutput,
  featureMergeInstructions,
  FILE_ROLLUP,
  FILE_SUMMARY,
  fileRollupInstructions,
  FileSummaryOutput,
  fileSummaryInstructions,
  LanguageModel,
  MODULE_SUMMARY,
  moduleSummaryInstructions,
  type PromptRef,
  renderCard,
  renderCardExcerpt,
  renderFeatureMap,
  renderFeatureMapFile,
  renderFeatureMerge,
  renderFileRollup,
  renderFileSummary,
  renderModuleSummary,
  RollupOutput,
  type SymbolLine
} from "@code-to-rag/ai"
import { Effect } from "effect"
import { randomUUID } from "node:crypto"
import { AppConfig } from "../config.ts"
import { type Job, JobId, type SnapshotId } from "../domain.ts"
import { InvalidInputError, PhaseError } from "../errors.ts"
import type { PhaseContext, Pipeline } from "../pipeline.ts"
import {
  type Declaration,
  type FileForUnderstanding,
  JobRepository,
  KnowledgeRepository,
  type NewFeature,
  type NewFileSummary,
  SnapshotRepository,
  UnderstandingRepository
} from "../ports.ts"
import { buildCardExcerpts } from "./excerpts.ts"
import { dedupeFeatures, mergeFeatures, normalizeFeatures } from "./features.ts"
import { planModules } from "./modules.ts"
import { splitIntoParts } from "./parts.ts"
import { checkReferences } from "./references.ts"
import { selectFiles } from "./select.ts"

/** Summaries and cards are always written in English. */
export const UNDERSTANDING_LANGUAGE = "en"

/** Files loaded and summarized together (the model's own concurrency limit still applies). */
const FILE_BATCH_SIZE = 8
const CARD_BATCH_SIZE = 4
/** Tokens kept free for the chat template and estimation errors. */
const SAFETY_TOKENS = 512
/** Declarations listed in a file prompt and per file in the feature map. */
const MAX_FILE_DECLARATIONS = 80
const MAX_FEATURE_MAP_DECLARATIONS = 6

type Progress = PhaseContext["progress"]

const chunks = <A>(items: ReadonlyArray<A>, size: number): Array<ReadonlyArray<A>> => {
  const result: Array<ReadonlyArray<A>> = []
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size))
  return result
}

const groupBy = <A>(items: ReadonlyArray<A>, key: (item: A) => string): Map<string, Array<A>> => {
  const groups = new Map<string, Array<A>>()
  for (const item of items) {
    const k = key(item)
    const group = groups.get(k)
    if (group === undefined) groups.set(k, [item])
    else group.push(item)
  }
  return groups
}

/** Database errors are transient; model errors carry their own `retryable`. */
const toPhaseError = (phase: string) => (error: { readonly _tag: string }) => {
  if (error instanceof AiError) return new PhaseError({ phase, message: error.message, retryable: error.retryable })
  if (error instanceof PhaseError) return error
  return new PhaseError({
    phase,
    message: error._tag === "DatabaseError" ? "Errore del database" : "Errore imprevisto durante la comprensione",
    retryable: error._tag !== "NotFoundError"
  })
}

/**
 * Runs a model task for one item; an answer still invalid after the correction
 * request skips the item (counted) instead of failing the whole job.
 */
const skipInvalid = <A, R>(effect: Effect.Effect<A, AiError, R>, onSkip: () => void) =>
  effect.pipe(
    Effect.map((value): A | undefined => value),
    Effect.catchIf(
      (error) => error.kind === "invalid_output",
      () => Effect.sync(() => (onSkip(), undefined))
    )
  )

/** Input token budget of a prompt with the given instructions. */
const inputBudget = (model: typeof LanguageModel.Service, instructions: string): number =>
  model.contextTokens - model.maxOutputTokens - estimateTokens(instructions) - SAFETY_TOKENS

const provenance = (model: typeof LanguageModel.Service, prompt: PromptRef) => ({
  model: model.modelId ?? "unknown",
  promptVersion: prompt.version
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
    const moduleSummaries = new Map((yield* knowledge.moduleSummaries(job.snapshotId)).map((s) => [s.path, s.summary]))
    const plan = planModules([...fileSummaries.keys()])
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

const mapFeatures = Effect.fn("understanding.mapFeatures")(
  function* (job: Job, progress: Progress) {
    const understanding = yield* UnderstandingRepository
    const knowledge = yield* KnowledgeRepository
    const model = yield* LanguageModel
    const context = { phase: "map-features", jobId: job.id, snapshotId: job.snapshotId }

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
    yield* progress({
      completed: batches.length,
      total: batches.length,
      message: `${features.length} funzionalità individuate`
    })
  },
  (effect) => effect.pipe(Effect.mapError(toPhaseError("map-features")))
)

// ---------------------------------------------------------------------------
// generate-cards

const generateCards = Effect.fn("understanding.generateCards")(
  function* (job: Job, progress: Progress) {
    const understanding = yield* UnderstandingRepository
    const knowledge = yield* KnowledgeRepository
    const model = yield* LanguageModel

    const info = yield* understanding.snapshotInfo(job.snapshotId)
    const { features } = yield* knowledge.featureMap(job.snapshotId)
    const pending = features.filter((feature) => feature.card === null)
    const summaries = new Map((yield* knowledge.fileSummaries(job.snapshotId)).map((s) => [s.path, s.summary]))
    const declarations = yield* understanding.declarations(job.snapshotId)
    const budget = inputBudget(model, cardInstructions)

    let completed = features.length - pending.length
    let skipped = 0
    const report = () =>
      progress({
        completed,
        total: features.length,
        message: `${completed} di ${features.length} schede generate${skipped > 0 ? ` (${skipped} saltate)` : ""}`
      })
    yield* report()

    for (const batch of chunks(pending, CARD_BATCH_SIZE)) {
      yield* Effect.forEach(
        batch,
        (feature) =>
          Effect.gen(function* () {
            const files = yield* understanding.loadFiles(job.snapshotId, feature.files)
            const header = estimateTokens(renderCard({ feature, excerpts: [], omitted: [] }))
            const { excerpts, omitted, shown } = buildCardExcerpts({
              files,
              summaries,
              featureSymbols: feature.symbols,
              declarations: declarations.filter((d) => feature.files.includes(d.path)),
              maxTokens: Math.max(512, budget - header - feature.files.length * 40)
            })
            if (excerpts.length === 0) {
              skipped++
              return
            }
            const answer = yield* skipInvalid(
              model.generateObject({
                prompt: CARD,
                context: { phase: "generate-cards", jobId: job.id, snapshotId: job.snapshotId },
                instructions: cardInstructions,
                input: renderCard({ feature, excerpts: excerpts.map(renderCardExcerpt), omitted }),
                schema: CardContent
              }),
              () => skipped++
            )
            if (answer === undefined) return
            const checked = checkReferences(answer, shown)
            yield* knowledge.saveCard(
              job.snapshotId,
              {
                featureId: feature.id,
                status: "generated",
                content: checked.content,
                sourceRevision: info.revision,
                unreferencedStatements: checked.unreferencedStatements,
                references: checked.references
              },
              provenance(model, CARD)
            )
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
// finalize

const finalize = Effect.fn("understanding.finalize")(
  function* (job: Job) {
    const knowledge = yield* KnowledgeRepository
    const understanding = yield* UnderstandingRepository
    const counts = yield* knowledge.counts(job.snapshotId)
    yield* understanding.complete(job.snapshotId, counts)
  },
  (effect) => effect.pipe(Effect.mapError(toPhaseError("finalize")))
)

export const understandingPipeline: Pipeline<
  JobRepository | KnowledgeRepository | LanguageModel | SnapshotRepository | UnderstandingRepository
> = {
  type: "understanding",
  phases: [
    { name: "prepare", run: ({ job }) => prepare(job) },
    { name: "summarize-files", run: ({ job, progress }) => summarizeFiles(job, progress) },
    { name: "summarize-modules", run: ({ job, progress }) => summarizeModules(job, progress) },
    { name: "map-features", run: ({ job, progress }) => mapFeatures(job, progress) },
    { name: "generate-cards", run: ({ job, progress }) => generateCards(job, progress) },
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
  const job = yield* jobs.enqueue({
    id: JobId.make(randomUUID()),
    type: "understanding",
    projectId: snapshot.projectId,
    snapshotId,
    maxAttempts: config.jobMaxAttempts
  })
  if (job.status === "queued") yield* understanding.setStatus(snapshotId, "pending")
  return job
})
