/**
 * Embedding index of the cards. An `indexing` job brings the index of a
 * snapshot in line with its cards: cards without chunks for their current
 * version (and the configured model) are chunked and embedded. It is queued
 * after the understanding, after every card job and after manual edits.
 */
import { EmbeddingModel } from "../../ports/outbound/models.ts"
import { Effect, Option } from "effect"
import { AppConfig } from "../config.ts"
import { type Job, JobId, type SnapshotId } from "../../domain/model.ts"
import { PhaseError } from "../../domain/errors.ts"
import type { PhaseContext, Pipeline } from "../pipeline.ts"
import { IndexRepository, JobRepository, SnapshotRepository } from "../../ports/outbound/repositories.ts"
import { chunks, toPhaseError } from "../understanding/shared.ts"
import { CARD_CHUNK, cardChunks } from "./chunks.ts"

/** Cards embedded per round (their chunks are sent together, split by `EMBEDDING_BATCH_SIZE`). */
const CARD_BATCH_SIZE = 8
/** Rounds: cards edited while the job runs are picked up by the next round. */
const MAX_ROUNDS = 3

const indexCards = Effect.fn("rag.indexCards")(
  function* (job: Job, progress: PhaseContext["progress"]) {
    const index = yield* IndexRepository
    const embeddings = yield* EmbeddingModel
    const model = embeddings.modelId
    if (model === undefined) {
      return yield* new PhaseError({
        phase: "index",
        message: "Modello di embedding non configurato (EMBEDDING_MODEL)",
        retryable: false
      })
    }
    const meta = { model, formatVersion: CARD_CHUNK.version }
    const context = { phase: "index", jobId: job.id, snapshotId: job.snapshotId }
    let completed = 0
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const pending = yield* index.cardsToIndex(job.snapshotId, meta)
      if (pending.length === 0) break
      const total = completed + pending.length
      for (const batch of chunks(pending, CARD_BATCH_SIZE)) {
        const perCard = batch.map((card) => ({ card, chunks: cardChunks(card.featureName, card.content) }))
        const vectors = yield* embeddings.embed({
          format: CARD_CHUNK,
          context,
          texts: perCard.flatMap((entry) => entry.chunks.map((chunk) => chunk.text))
        })
        let offset = 0
        for (const entry of perCard) {
          const embedded = entry.chunks.map((chunk, i) => ({ ...chunk, embedding: vectors[offset + i] ?? [] }))
          offset += entry.chunks.length
          yield* index.saveChunks(
            job.snapshotId,
            { cardId: entry.card.cardId, version: entry.card.version },
            embedded,
            meta
          )
        }
        completed += batch.length
        yield* progress({ completed, total, message: `${completed} di ${total} schede indicizzate` })
      }
    }
    if (completed === 0) yield* progress({ completed: 0, total: 0, message: "Indice già aggiornato" })
  },
  (effect) => effect.pipe(Effect.mapError(toPhaseError("index")))
)

export const indexingPipeline: Pipeline<EmbeddingModel | IndexRepository> = {
  type: "indexing",
  phases: [{ name: "index", run: ({ job, progress }) => indexCards(job, progress) }],
  // Chunks are saved per card: what was indexed stays usable.
  onFailed: () => Effect.void
}

/**
 * Queues the indexing of a snapshot. A job already queued absorbs the request;
 * a running one does not (it may have passed the changed card). Does nothing
 * when embeddings are not configured.
 */
export const requestIndexing = Effect.fn("requestIndexing")(function* (snapshotId: SnapshotId) {
  const embeddings = yield* EmbeddingModel
  if (embeddings.modelId === undefined) return Option.none<Job>()
  const config = yield* AppConfig
  const jobs = yield* JobRepository
  const snapshots = yield* SnapshotRepository
  const { snapshot } = yield* snapshots.get(snapshotId)
  return Option.some(
    yield* jobs.enqueue({
      id: JobId.make(crypto.randomUUID()),
      type: "indexing",
      projectId: snapshot.projectId,
      snapshotId,
      maxAttempts: config.jobMaxAttempts,
      dedupe: "queued"
    })
  )
})

/** Deletes the index of a snapshot and builds it again (e.g. after changing the embedding model's settings). */
export const rebuildIndex = Effect.fn("rebuildIndex")(function* (snapshotId: SnapshotId) {
  const index = yield* IndexRepository
  yield* index.clear(snapshotId)
  return yield* requestIndexing(snapshotId)
})
