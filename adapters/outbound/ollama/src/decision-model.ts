import {
  AiError,
  DecisionModel,
  type DecisionRequest,
  type ModelCallOutcome,
  ModelCallRecorder
} from "@code-to-rag/core/outbound"
import { Cause, type Duration, Effect, Exit, Layer, Schedule, Schema, Semaphore } from "effect"
import { Agent, fetch as undiciFetch } from "undici"
import { DecisionConfig, type DecisionConfigShape } from "./config.ts"

/**
 * No headers or body timeout from undici (Node's fetch gives up after 5 minutes without headers): the only limit is
 * `DECISION_TIMEOUT`, applied around each request.
 */
const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 })

const decisionFetch = ((input: Parameters<typeof undiciFetch>[0], init?: Parameters<typeof undiciFetch>[1]) =>
  undiciFetch(input, { ...init, dispatcher })) as unknown as typeof globalThis.fetch

const SystemOneResponse = Schema.Struct({
  answers: Schema.Record(Schema.String, Schema.Struct({ type: Schema.Literal("noul"), noul: Schema.Number })),
  usage: Schema.optional(Schema.Struct({ input_tokens: Schema.optional(Schema.Number) }))
})

/** HTTP failure of the System One API: only the status is kept (the body may echo the request). */
class HttpStatusError extends Error {
  readonly status: number
  constructor(status: number) {
    super(`HTTP ${status}`)
    this.name = "HttpStatusError"
    this.status = status
  }
}

const describeError = (error: unknown): string => {
  if (error instanceof HttpStatusError) return `${error.name} ${error.status}`
  if (error instanceof Error) return error.name
  return "UnknownError"
}

const toAiError = (error: unknown, model: string): AiError => {
  if (error instanceof HttpStatusError) {
    if (error.status === 404) {
      return new AiError({
        kind: "provider",
        message: `Modello decisionale ${model} non trovato: scaricalo con "ollama pull ${model}"`,
        retryable: false
      })
    }
    const retryable = error.status === 408 || error.status === 429 || error.status >= 500
    return new AiError({
      kind: "provider",
      message: `Errore del modello decisionale (HTTP ${error.status})`,
      retryable
    })
  }
  return new AiError({
    kind: "provider",
    message: `Modello decisionale non raggiungibile (${describeError(error)})`,
    retryable: true
  })
}

/** Adapter of the `DecisionModel` port: Ollama's `POST /v1/systemone`, model from `DECISION_*`. */
export const DecisionModelLive = Layer.effect(
  DecisionModel,
  Effect.gen(function* () {
    return yield* makeDecisionModel({ config: yield* DecisionConfig })
  })
)

/** Builds the service; `fetch` and the retry delay are replaceable in tests. */
export const makeDecisionModel = Effect.fnUntraced(function* (options: {
  readonly config: DecisionConfigShape
  readonly fetch?: typeof globalThis.fetch | undefined
  readonly retryBaseDelay?: Duration.Input | undefined
}) {
  const { config } = options
  const fetch = options.fetch ?? decisionFetch
  const recorder = yield* ModelCallRecorder
  const semaphore = yield* Semaphore.make(Math.max(1, config.concurrency))
  const url = `${config.baseUrl}/v1/systemone`

  const call = (request: DecisionRequest) =>
    Effect.gen(function* () {
      const startedAt = Date.now()
      const body = {
        model: config.model,
        state: request.state,
        keep_alive: config.keepAlive,
        questions: Object.fromEntries(
          Object.entries(request.questions).map(([name, question]) => [
            name,
            {
              type: "noul",
              instructions: question.instructions,
              ...(question.criteria === undefined ? {} : { criteria: question.criteria })
            }
          ])
        )
      }
      const exit = yield* Effect.tryPromise({
        try: async (signal) => {
          const response = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal
          })
          if (!response.ok) {
            await response.body?.cancel()
            throw new HttpStatusError(response.status)
          }
          return await response.json()
        },
        catch: (error) => error
      }).pipe(Effect.timeout(config.timeout), Effect.exit)

      const record = (outcome: ModelCallOutcome, inputTokens: number | null, error: string | null) =>
        recorder.record({
          ...request.context,
          task: request.prompt.id,
          promptVersion: request.prompt.version,
          provider: "ollama",
          model: config.model,
          attempt: 1,
          outcome,
          durationMs: Date.now() - startedAt,
          inputTokens,
          outputTokens: 0,
          error
        })

      if (Exit.isSuccess(exit)) {
        const decoded = Schema.decodeUnknownOption(SystemOneResponse)(exit.value)
        const answers = decoded._tag === "Some" ? decoded.value.answers : undefined
        const probabilities: Record<string, number> = {}
        for (const name of Object.keys(request.questions)) {
          const value = answers?.[name]?.noul
          if (value !== undefined && Number.isFinite(value)) probabilities[name] = Math.min(1, Math.max(0, value))
        }
        if (Object.keys(probabilities).length !== Object.keys(request.questions).length) {
          yield* record("invalid_output", null, "Unexpected answers")
          return yield* new AiError({
            kind: "invalid_output",
            message: "Il modello decisionale ha restituito una risposta non valida",
            retryable: false
          })
        }
        const inputTokens = decoded._tag === "Some" ? (decoded.value.usage?.input_tokens ?? null) : null
        yield* record("success", inputTokens, null)
        return probabilities
      }
      const failure = Cause.findErrorOption(exit.cause)
      if (failure._tag === "None") return yield* Effect.failCause(exit.cause as Cause.Cause<never>)
      const error = failure.value
      if (Cause.isTimeoutError(error)) {
        yield* record("timeout", null, "Timeout")
        return yield* new AiError({
          kind: "timeout",
          message: "Il modello decisionale non ha risposto in tempo",
          retryable: true
        })
      }
      yield* record("error", null, describeError(error))
      return yield* toAiError(error, config.model)
    }).pipe(
      semaphore.withPermits(1),
      Effect.retry({
        schedule: Schedule.exponential(options.retryBaseDelay ?? "2 seconds"),
        times: config.maxRetries,
        while: (error) => error.retryable
      }),
      Effect.withSpan("ai.decide", { attributes: { task: request.prompt.id, model: config.model } })
    )

  return DecisionModel.of({
    modelId: config.model,
    contextTokens: config.contextTokens,
    maxQuestions: config.maxQuestions,
    decide: call
  })
})
