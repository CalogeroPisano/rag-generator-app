import { Effect, Layer, Schema } from "effect"
import {
  AiError,
  DecisionModel,
  type DecisionRequest,
  EmbeddingModel,
  LanguageModel,
  type OutputSchema,
  type StructuredRequest,
  type TextRequest
} from "./ports/outbound/models.ts"

/**
 * Test doubles of the model ports (`@code-to-rag/core/testing`).
 *
 * Language model for tests of the code that uses the AI layer: `respond` gets
 * each request and returns the (encoded) answer, which is decoded with the
 * request schema like a real answer. Returning an `AiError` fails the call.
 */
export const scriptedLanguageModel = (
  respond: (request: StructuredRequest<OutputSchema>) => unknown,
  options: {
    readonly contextTokens?: number
    readonly maxOutputTokens?: number
    /** Text answers (chat): streamed to `onDelta` word by word. */
    readonly respondText?: (request: TextRequest) => string | AiError
  } = {}
) =>
  Layer.succeed(
    LanguageModel,
    LanguageModel.of({
      modelId: "scripted-test-model",
      contextTokens: options.contextTokens ?? 16_384,
      maxOutputTokens: options.maxOutputTokens ?? 4096,
      chatMaxOutputTokens: 1024,
      generateObject: <S extends OutputSchema>(request: StructuredRequest<S>) =>
        Effect.suspend(() => {
          const answer = respond(request)
          if (answer instanceof AiError) return Effect.fail(answer)
          return Schema.decodeUnknownEffect(Schema.toCodecJson(request.schema))(answer).pipe(
            Effect.mapError(
              () => new AiError({ kind: "invalid_output", message: "Invalid scripted answer", retryable: false })
            )
          )
        }),
      generateText: (request: TextRequest) =>
        Effect.suspend(() => {
          const answer = options.respondText?.(request) ?? "I do not know."
          if (answer instanceof AiError) return Effect.fail(answer)
          for (const piece of answer.split(/(?<= )/)) request.onDelta?.(piece)
          return Effect.succeed({ text: answer, truncated: false })
        })
    })
  )

/**
 * Decision model for tests: `respond` gets each request and returns the probability of "true" by question name
 * (questions left out get `fallback`, 0.9 by default). Returning an `AiError` fails the call.
 */
export const scriptedDecisionModel = (
  respond: (request: DecisionRequest) => Readonly<Record<string, number>> | AiError = () => ({}),
  options: { readonly contextTokens?: number; readonly maxQuestions?: number; readonly fallback?: number } = {}
) =>
  Layer.succeed(
    DecisionModel,
    DecisionModel.of({
      modelId: "scripted-decision-model",
      contextTokens: options.contextTokens ?? 16_384,
      maxQuestions: options.maxQuestions ?? 64,
      decide: (request) =>
        Effect.suspend(() => {
          const answer = respond(request)
          if (answer instanceof AiError) return Effect.fail(answer)
          return Effect.succeed(
            Object.fromEntries(
              Object.keys(request.questions).map((name) => [name, answer[name] ?? options.fallback ?? 0.9])
            )
          )
        })
    })
  )

const EMBEDDING_DIMENSIONS = 64

/**
 * Deterministic embeddings for tests: a normalized bag of hashed words, so that
 * texts sharing words are close. Returning an `AiError` from `fail` fails the call.
 */
export const hashEmbedding = (text: string): Array<number> => {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0)
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []) {
    let hash = 0
    for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
    vector[hash % EMBEDDING_DIMENSIONS]! += 1
  }
  const norm = Math.hypot(...vector) || 1
  return vector.map((value) => value / norm)
}

export const scriptedEmbeddingModel = (
  options: {
    /** `false`: behaves like a server without `EMBEDDING_MODEL` (no indexing, no chat). */
    readonly configured?: boolean
    readonly fail?: (texts: ReadonlyArray<string>) => AiError | undefined
  } = {}
) =>
  Layer.succeed(
    EmbeddingModel,
    EmbeddingModel.of({
      modelId: options.configured === false ? undefined : "scripted-embedding-model",
      embed: (request) =>
        Effect.suspend(() => {
          const error = options.fail?.(request.texts)
          return error === undefined ? Effect.succeed(request.texts.map(hashEmbedding)) : Effect.fail(error)
        })
    })
  )

// Output schema of a real prompt, for tests that call the language model port directly.
export { RollupOutput } from "./application/prompts/summaries.ts"
