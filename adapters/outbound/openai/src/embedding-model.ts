import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import {
  AiError,
  EmbeddingModel,
  type EmbeddingRequest,
  type ModelCallOutcome,
  ModelCallRecorder
} from "@code-to-rag/core/outbound"
import { APICallError, embedMany, type EmbeddingModel as SdkEmbeddingModel } from "ai"
import { Cause, type Duration, Effect, Exit, Layer, Redacted, Schedule, Semaphore } from "effect"
import { AiConfig, type AiConfigShape } from "./config.ts"
import { modelFetch } from "./fetch.ts"

/**
 * Adapter of the `EmbeddingModel` port: AI SDK with the OpenAI-compatible `/embeddings`, model from `EMBEDDING_*`.
 * Without `EMBEDDING_MODEL` every call fails with `not_configured`.
 */
export const EmbeddingModelLive = Layer.effect(
  EmbeddingModel,
  Effect.gen(function* () {
    const config = yield* AiConfig
    const embedding = config.embedding
    if (embedding.model === undefined) {
      return EmbeddingModel.of({
        modelId: undefined,
        embed: () =>
          Effect.fail(
            new AiError({
              kind: "not_configured",
              message: "Modello di embedding non configurato (EMBEDDING_MODEL)",
              retryable: false
            })
          )
      })
    }
    const provider = createOpenAICompatible({
      name: config.providerName,
      baseURL: embedding.baseUrl,
      ...(embedding.apiKey === undefined ? {} : { apiKey: Redacted.value(embedding.apiKey) }),
      fetch: modelFetch
    })
    return yield* makeEmbeddingModel({
      model: provider.embeddingModel(embedding.model),
      modelId: embedding.model,
      config
    })
  })
)

const describeError = (error: unknown): string => {
  if (APICallError.isInstance(error))
    return `${error.name}${error.statusCode === undefined ? "" : ` ${error.statusCode}`}`
  if (error instanceof Error) return error.name
  return "UnknownError"
}

/** Builds the service around an AI SDK embedding model. Exposed for tests. */
export const makeEmbeddingModel = Effect.fnUntraced(function* (options: {
  readonly model: SdkEmbeddingModel
  readonly modelId: string
  readonly config: AiConfigShape
  readonly retryBaseDelay?: Duration.Input | undefined
}) {
  const { model, modelId, config } = options
  const recorder = yield* ModelCallRecorder
  const semaphore = yield* Semaphore.make(Math.max(1, config.concurrency))
  const batchSize = Math.max(1, config.embedding.batchSize)

  const embedBatch = (request: EmbeddingRequest, texts: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const startedAt = Date.now()
      const exit = yield* Effect.tryPromise({
        try: (signal) => embedMany({ model, values: [...texts], maxRetries: 0, abortSignal: signal }),
        catch: (error) => error
      }).pipe(Effect.timeout(config.timeout), Effect.exit)

      const record = (outcome: ModelCallOutcome, inputTokens: number | null, error: string | null) =>
        recorder.record({
          ...request.context,
          task: request.format.id,
          promptVersion: request.format.version,
          provider: config.providerName,
          model: modelId,
          attempt: 1,
          outcome,
          durationMs: Date.now() - startedAt,
          inputTokens,
          outputTokens: null,
          error
        })

      if (Exit.isSuccess(exit)) {
        const { embeddings, usage } = exit.value
        if (embeddings.length !== texts.length || embeddings.some((vector) => vector.length === 0)) {
          yield* record("invalid_output", usage.tokens, "Unexpected embeddings")
          return yield* new AiError({
            kind: "invalid_output",
            message: "Il modello di embedding ha restituito una risposta non valida",
            retryable: false
          })
        }
        yield* record("success", usage.tokens, null)
        return embeddings
      }
      const failure = Cause.findErrorOption(exit.cause)
      if (failure._tag === "None") return yield* Effect.failCause(exit.cause as Cause.Cause<never>)
      const error = failure.value
      if (Cause.isTimeoutError(error)) {
        yield* record("timeout", null, "Timeout")
        return yield* new AiError({
          kind: "timeout",
          message: "Il modello di embedding non ha risposto in tempo",
          retryable: true
        })
      }
      yield* record("error", null, describeError(error))
      return yield* new AiError({
        kind: "provider",
        message: `Errore del modello di embedding (${describeError(error)})`,
        retryable: APICallError.isInstance(error) ? error.isRetryable : true
      })
    }).pipe(
      semaphore.withPermits(1),
      Effect.retry({
        schedule: Schedule.exponential(options.retryBaseDelay ?? "2 seconds"),
        times: config.maxRetries,
        while: (error) => error.retryable
      })
    )

  const embed = (request: EmbeddingRequest) =>
    Effect.gen(function* () {
      const batches: Array<ReadonlyArray<string>> = []
      for (let i = 0; i < request.texts.length; i += batchSize) batches.push(request.texts.slice(i, i + batchSize))
      const results = yield* Effect.forEach(batches, (texts) => embedBatch(request, texts))
      return results.flat()
    }).pipe(Effect.withSpan("ai.embed", { attributes: { task: request.format.id, model: modelId } }))

  return EmbeddingModel.of({ modelId, embed })
})
