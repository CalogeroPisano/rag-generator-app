/**
 * Hybrid retrieval: a vector search (meaning, across languages) and a
 * full-text search (exact words: parameter names, error codes, messages) over
 * the card chunks, fused with Reciprocal Rank Fusion and grouped by card.
 */
import { EmbeddingModel, type ModelCallContext } from "@code-to-rag/ai"
import { Effect } from "effect"
import type { SnapshotId } from "../domain.ts"
import { InvalidInputError } from "../errors.ts"
import { type ChunkHit, IndexRepository } from "../ports.ts"
import { CHAT_QUERY } from "./chunks.ts"

/** RRF constant: dampens the weight of the first positions (60 is the usual value). */
const RRF_K = 60
const MAX_TERMS = 24

/** Distinct words of the question for the full-text search (3+ letters or digits, lower case). */
export const searchTerms = (question: string): Array<string> =>
  [...new Set((question.toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? []).slice(0, MAX_TERMS * 2))].slice(0, MAX_TERMS)

export interface RankedCard {
  readonly cardId: string
  readonly score: number
}

/**
 * Fuses ranked chunk lists: each card scores, in each list, 1 / (k + rank of
 * its best chunk); scores are summed across lists.
 */
export const fuseRankings = (lists: ReadonlyArray<ReadonlyArray<ChunkHit>>): Array<RankedCard> => {
  const scores = new Map<string, number>()
  for (const list of lists) {
    const seen = new Set<string>()
    list.forEach((hit, index) => {
      if (seen.has(hit.cardId)) return
      seen.add(hit.cardId)
      scores.set(hit.cardId, (scores.get(hit.cardId) ?? 0) + 1 / (RRF_K + index + 1))
    })
  }
  return [...scores].map(([cardId, score]) => ({ cardId, score })).sort((a, b) => b.score - a.score)
}

/** Cards most relevant to a question, best first. */
export const retrieveCards = Effect.fn("rag.retrieveCards")(function* (
  snapshotId: SnapshotId,
  question: string,
  options: {
    readonly approvedOnly: boolean
    readonly limit: number
    readonly candidates: number
    readonly context: ModelCallContext
  }
) {
  const embeddings = yield* EmbeddingModel
  const index = yield* IndexRepository
  const model = embeddings.modelId
  if (model === undefined) {
    return yield* new InvalidInputError({ message: "Modello di embedding non configurato (EMBEDDING_MODEL)" })
  }
  const [embedding] = yield* embeddings.embed({ format: CHAT_QUERY, context: options.context, texts: [question] })
  const hits = yield* index.search(snapshotId, {
    embedding: embedding ?? [],
    model,
    terms: searchTerms(question),
    limit: options.candidates,
    approvedOnly: options.approvedOnly
  })
  return fuseRankings([hits.vector, hits.text]).slice(0, options.limit)
})
