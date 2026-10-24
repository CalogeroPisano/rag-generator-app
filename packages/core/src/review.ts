/**
 * Review of the cards (phase 4): operations that need a model run as `card`
 * jobs (verify, regenerate, correct); manual edits and review decisions are
 * immediate. Also project deletion.
 */
import { CARD, CARD_VERIFY, type CardContent, LanguageModel } from "@code-to-rag/ai"
import { Effect } from "effect"
import { randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import { AppConfig } from "./config.ts"
import { type CardJobPayload, type CardOperation, type Job, JobId, type ProjectId, type SnapshotId } from "./domain.ts"
import { InvalidInputError, NotFoundError, PhaseError } from "./errors.ts"
import type { Pipeline } from "./pipeline.ts"
import {
  JobRepository,
  KnowledgeRepository,
  ProjectRepository,
  type Reviewer,
  SnapshotRepository,
  UnderstandingRepository
} from "./ports.ts"
import { type CallContext, type CardSources, loadCardSources, verifyCard, writeCard } from "./understanding/cards.ts"
import { checkReferences } from "./understanding/references.ts"
import { provenance, toPhaseError } from "./understanding/shared.ts"
import { uploadPath } from "./acquisition.ts"

/** The feature of a card job and its current card (looked up by feature: regeneration replaces the card id). */
const featureWithCard = Effect.fnUntraced(function* (snapshotId: SnapshotId, featureId: string) {
  const knowledge = yield* KnowledgeRepository
  const { features } = yield* knowledge.featureMap(snapshotId)
  const feature = features.find((f) => f.id === featureId)
  if (feature?.card == null) return yield* new NotFoundError({ entity: "card", id: featureId })
  return { feature, card: yield* knowledge.getCard(snapshotId, feature.card.id) }
})

/** Verifies the current card of a feature and stores the result. */
const verifyStored = Effect.fnUntraced(function* (context: CallContext, featureId: string, sources: CardSources) {
  const knowledge = yield* KnowledgeRepository
  const model = yield* LanguageModel
  const { card } = yield* featureWithCard(context.snapshotId, featureId)
  const verification = yield* verifyCard(context, card.feature, sources, card)
  yield* knowledge.saveVerification(context.snapshotId, card.id, verification, provenance(model, CARD_VERIFY))
})

/** Writes a new version of the card of a feature (from scratch or from the current one), then verifies it. */
const rewrite = Effect.fnUntraced(function* (
  context: CallContext,
  featureId: string,
  sources: CardSources,
  options: { readonly fromCurrent: boolean }
) {
  const knowledge = yield* KnowledgeRepository
  const understanding = yield* UnderstandingRepository
  const model = yield* LanguageModel
  const { card } = yield* featureWithCard(context.snapshotId, featureId)
  const corrections = (yield* knowledge.corrections(context.snapshotId)).filter((c) => c.featureId === featureId)
  const checked = yield* writeCard(context, card.feature, sources, {
    current: options.fromCurrent ? card.content : null,
    corrections: corrections.map((c) => c.text)
  })
  if (checked === undefined) {
    return yield* new PhaseError({
      phase: context.phase,
      message: "Nessun file della funzionalità è disponibile per riscrivere la scheda",
      retryable: false
    })
  }
  const info = yield* understanding.snapshotInfo(context.snapshotId)
  const version = yield* knowledge.saveCard(
    context.snapshotId,
    {
      featureId,
      // A corrected card waits for a reviewer; a regenerated one starts over.
      status: options.fromCurrent ? "in_review" : "generated",
      content: checked.content,
      sourceRevision: info.revision,
      unreferencedStatements: checked.unreferencedStatements,
      references: checked.references
    },
    provenance(model, CARD)
  )
  if (corrections.length > 0) {
    yield* knowledge.markCorrectionsApplied(
      corrections.map((c) => c.id),
      version
    )
  }
  yield* verifyStored(context, featureId, sources)
})

const processCardJob = Effect.fn("review.processCardJob")(
  function* (job: Job) {
    const payload = job.payload
    if (payload === null) {
      return yield* new PhaseError({
        phase: "process",
        message: "Operazione sulla scheda non valida",
        retryable: false
      })
    }
    const context = { phase: payload.operation, jobId: job.id, snapshotId: job.snapshotId }
    const sources = yield* loadCardSources(job.snapshotId)
    switch (payload.operation) {
      case "verify":
        return yield* verifyStored(context, payload.featureId, sources)
      case "regenerate":
        return yield* rewrite(context, payload.featureId, sources, { fromCurrent: false })
      case "correct":
        return yield* rewrite(context, payload.featureId, sources, { fromCurrent: true })
    }
  },
  (effect) => effect.pipe(Effect.mapError(toPhaseError("process")))
)

export const cardPipeline: Pipeline<KnowledgeRepository | LanguageModel | UnderstandingRepository> = {
  type: "card",
  phases: [{ name: "process", run: ({ job }) => processCardJob(job) }],
  // The card keeps its previous version: nothing to undo.
  onFailed: () => Effect.void
}

// ---------------------------------------------------------------------------
// Use cases

const ensureNoUnderstanding = Effect.fnUntraced(function* (projectId: ProjectId) {
  const jobs = yield* JobRepository
  const active = yield* jobs.active(projectId)
  if (active.some((job) => job.type === "understanding")) {
    return yield* new InvalidInputError({ message: "La comprensione con IA è in corso: riprova al termine" })
  }
})

/** Queues an operation on a card (one active job per card). */
export const requestCardOperation = Effect.fn("requestCardOperation")(function* (
  snapshotId: SnapshotId,
  cardId: string,
  operation: CardOperation
) {
  const config = yield* AppConfig
  const jobs = yield* JobRepository
  const knowledge = yield* KnowledgeRepository
  const snapshots = yield* SnapshotRepository
  const { snapshot } = yield* snapshots.get(snapshotId)
  yield* ensureNoUnderstanding(snapshot.projectId)
  const card = yield* knowledge.getCard(snapshotId, cardId)
  return yield* jobs.enqueue({
    id: JobId.make(randomUUID()),
    type: "card",
    projectId: snapshot.projectId,
    snapshotId,
    maxAttempts: config.jobMaxAttempts,
    payload: { cardId, featureId: card.feature.id, operation } satisfies CardJobPayload,
    dedupeKey: card.feature.id
  })
})

/** Assisted correction: the reviewer describes the mistake, the model rewrites the card checking the code again. */
export const correctCard = Effect.fn("correctCard")(function* (
  snapshotId: SnapshotId,
  cardId: string,
  text: string,
  reviewer: Reviewer
) {
  const knowledge = yield* KnowledgeRepository
  const snapshots = yield* SnapshotRepository
  const trimmed = text.trim()
  if (trimmed === "") return yield* new InvalidInputError({ message: "Descrivi l'errore da correggere" })
  const { snapshot } = yield* snapshots.get(snapshotId)
  yield* ensureNoUnderstanding(snapshot.projectId)
  const card = yield* knowledge.getCard(snapshotId, cardId)
  yield* knowledge.addCorrection({
    projectId: snapshot.projectId,
    featureId: card.feature.id,
    featureName: card.feature.name,
    text: trimmed,
    author: reviewer
  })
  return yield* requestCardOperation(snapshotId, cardId, "correct")
})

/**
 * Manual edit. References must point to existing lines of the snapshot's files;
 * the others are dropped (and counted, like for generated cards).
 */
export const editCard = Effect.fn("editCard")(function* (
  snapshotId: SnapshotId,
  cardId: string,
  content: CardContent,
  reviewer: Reviewer
) {
  const knowledge = yield* KnowledgeRepository
  const snapshots = yield* SnapshotRepository
  const files = yield* snapshots.listFiles(snapshotId)
  const shown = new Map(
    files
      .filter((file) => !file.isDirectory && file.excludedReason === null)
      .map((file) => [file.path, { totalLines: file.lineCount, ranges: [[1, file.lineCount] as const] }])
  )
  const checked = checkReferences(content, shown)
  yield* knowledge.editCard(snapshotId, cardId, checked, reviewer)
})

export const setCardStatus = Effect.fn("setCardStatus")(function* (
  snapshotId: SnapshotId,
  cardId: string,
  status: "approved" | "excluded" | "in_review",
  reviewer: Reviewer
) {
  const knowledge = yield* KnowledgeRepository
  yield* knowledge.setCardStatus(snapshotId, cardId, status, reviewer)
})

/**
 * Deletes a project with everything it produced: application data, uploaded
 * archives and its knowledge in the `rag` schema. Refused while one of its jobs
 * is running (queued jobs are deleted with it).
 */
export const deleteProject = Effect.fn("deleteProject")(function* (projectId: ProjectId) {
  const config = yield* AppConfig
  const jobs = yield* JobRepository
  const projects = yield* ProjectRepository
  const knowledge = yield* KnowledgeRepository
  yield* projects.get(projectId)
  const active = yield* jobs.active(projectId)
  if (active.some((job) => job.status === "running")) {
    return yield* new InvalidInputError({
      message: "Un'operazione del progetto è in corso: riprova al termine"
    })
  }
  // The rag schema has no foreign keys to the application tables: its rows are deleted explicitly.
  yield* knowledge.deleteProject(projectId)
  const { uploadIds } = yield* projects.delete(projectId)
  yield* Effect.forEach(
    uploadIds,
    (id) => Effect.promise(() => fs.rm(uploadPath(config.uploadsDir, id), { force: true })),
    { discard: true }
  )
  yield* Effect.logInfo("Project deleted").pipe(Effect.annotateLogs({ projectId }))
})
