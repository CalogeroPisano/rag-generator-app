import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import {
  APICallError,
  streamText,
  jsonSchema,
  type JSONSchema7,
  type LanguageModel as SdkLanguageModel,
  type ModelMessage,
  NoObjectGeneratedError,
  Output
} from "ai"
import { Cause, Context, type Duration, Effect, Exit, Layer, Redacted, Schedule, Schema, Semaphore } from "effect"
import { AiConfig, type AiConfigShape } from "./config.ts"
import { AiError } from "./errors.ts"
import { type ModelCallContext, type ModelCallOutcome, ModelCallRecorder } from "./model-call.ts"

/** A versioned prompt: changing the text of a prompt means bumping its version. */
export interface PromptRef {
  readonly id: string
  readonly version: number
}

export type OutputSchema = Schema.Top & { readonly DecodingServices: never }

export interface StructuredRequest<S extends OutputSchema> {
  readonly prompt: PromptRef
  readonly context: ModelCallContext
  readonly instructions: string
  /** User message. It may contain (masked) source code: it is never logged. */
  readonly input: string
  /** Output schema: sent to the model as JSON Schema and used to validate the answer. */
  readonly schema: S
  readonly maxOutputTokens?: number | undefined
}

export interface LanguageModelShape {
  /** Model id, recorded with every generated artifact. */
  readonly modelId: string | undefined
  /** Token budget of a single call (input + output). */
  readonly contextTokens: number
  readonly maxOutputTokens: number
  /**
   * Asks for a structured answer. An answer that does not match the schema gets
   * one correction request; if that is invalid too, fails with `invalid_output`.
   */
  generateObject<S extends OutputSchema>(request: StructuredRequest<S>): Effect.Effect<S["Type"], AiError>
}

/** Chat model behind the AI layer (AI SDK, OpenAI-compatible provider). */
export class LanguageModel extends Context.Service<LanguageModel, LanguageModelShape>()(
  "code-to-rag/ai/LanguageModel"
) {
  /** Model from the `AI_*` configuration; without `AI_MODEL` every call fails with `not_configured`. */
  static readonly layer = Layer.effect(
    LanguageModel,
    Effect.gen(function* () {
      const config = yield* AiConfig
      if (config.model === undefined) return notConfigured(config)
      const provider = createOpenAICompatible({
        name: config.providerName,
        baseURL: config.baseUrl,
        ...(config.apiKey === undefined ? {} : { apiKey: Redacted.value(config.apiKey) }),
        supportsStructuredOutputs: config.structuredOutputs,
        includeUsage: true
      })
      return yield* makeLanguageModel({ model: provider.chatModel(config.model), modelId: config.model, config })
    })
  )
}

const notConfigured = (config: AiConfigShape): LanguageModelShape => ({
  modelId: undefined,
  contextTokens: config.contextTokens,
  maxOutputTokens: config.maxOutputTokens,
  generateObject: () =>
    Effect.fail(
      new AiError({
        kind: "not_configured",
        message: "Modello IA non configurato (AI_MODEL)",
        retryable: false
      })
    )
})

/** Converts an Effect schema into the JSON Schema sent to the model. */
export const toModelJsonSchema = (schema: Schema.Top): JSONSchema7 => {
  const document = Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" })
  const definitions = Object.keys(document.definitions).length > 0 ? { $defs: document.definitions } : {}
  return { ...document.schema, ...definitions }
}

/** Raw answer of one call; `value` is the parsed JSON, not validated yet. */
interface RawAnswer {
  readonly text: string
  readonly value: unknown
  /** The model stopped at the output token limit: the JSON is cut off. */
  readonly truncated: boolean
}

/**
 * Streams the answer instead of waiting for it: local models on CPU can take
 * longer than the 5 minutes Node's fetch waits for response headers, while a
 * stream sends them at once. The text is collected and parsed at the end;
 * `undefined` means "not parsable JSON" (handled like a schema mismatch).
 */
const streamAnswer = async (options: Parameters<typeof streamText>[0]) => {
  let failure: { readonly error: unknown } | undefined
  const result = streamText({
    ...options,
    // Errors are reported through the stream below; the default handler would print them to the console.
    onError: () => undefined
  })
  for await (const part of result.stream) {
    if (part.type === "error") failure ??= { error: part.error }
  }
  if (failure !== undefined) {
    // The SDK may reject an unparsable answer itself: same handling as our own parse failure.
    if (NoObjectGeneratedError.isInstance(failure.error)) {
      return {
        text: failure.error.text ?? "",
        usage: failure.error.usage,
        value: undefined,
        truncated: failure.error.finishReason === "length"
      }
    }
    throw failure.error
  }
  const [text, usage, finishReason] = await Promise.all([result.text, result.usage, result.finishReason])
  return { text, usage, value: parseJson(text), truncated: finishReason === "length" }
}

/** Parses the model's JSON, tolerating a Markdown code fence around it. */
const parseJson = (text: string): unknown => {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed)
  try {
    return JSON.parse(fenced?.[1] ?? trimmed) as unknown
  } catch {
    return undefined
  }
}

/** Limits the size of validation messages sent back to the model. */
const MAX_REPAIR_ISSUES = 2000

/** Error name and HTTP status only: provider messages and bodies may echo the prompt. */
const describeError = (error: unknown): string => {
  if (APICallError.isInstance(error))
    return `${error.name}${error.statusCode === undefined ? "" : ` ${error.statusCode}`}`
  if (error instanceof Error) return error.name
  return "UnknownError"
}

/**
 * Builds the service around an AI SDK model. Exposed for tests, which pass a
 * mock model (`MockLanguageModelV4` from `ai/test`).
 */
export const makeLanguageModel = Effect.fnUntraced(function* (options: {
  readonly model: SdkLanguageModel
  readonly modelId: string
  readonly config: AiConfigShape
  /** First retry delay (doubles at every retry). */
  readonly retryBaseDelay?: Duration.Input | undefined
}) {
  const { model, modelId, config } = options
  const recorder = yield* ModelCallRecorder
  const semaphore = yield* Semaphore.make(Math.max(1, config.concurrency))

  /** One HTTP call, recorded in the call log whatever its outcome. */
  const call = <S extends OutputSchema>(
    request: StructuredRequest<S>,
    messages: Array<ModelMessage>,
    attempt: number
  ) =>
    Effect.gen(function* () {
      const startedAt = Date.now()
      const exit = yield* Effect.tryPromise({
        try: (signal) =>
          streamAnswer({
            model,
            instructions: request.instructions,
            messages,
            output: Output.object({ schema: jsonSchema(toModelJsonSchema(request.schema)) }),
            maxOutputTokens: request.maxOutputTokens ?? config.maxOutputTokens,
            temperature: config.temperature,
            // Retries are handled below, with the call log and the concurrency limit.
            maxRetries: 0,
            abortSignal: signal
          }),
        catch: (error) => error
      }).pipe(Effect.timeout(config.timeout), Effect.exit)

      const record = (
        outcome: ModelCallOutcome,
        usage: { readonly inputTokens: number | undefined; readonly outputTokens: number | undefined } | undefined,
        error: string | null
      ) =>
        recorder.record({
          ...request.context,
          task: request.prompt.id,
          promptVersion: request.prompt.version,
          provider: config.providerName,
          model: modelId,
          attempt,
          outcome,
          durationMs: Date.now() - startedAt,
          inputTokens: usage?.inputTokens ?? null,
          outputTokens: usage?.outputTokens ?? null,
          error
        })

      if (Exit.isSuccess(exit)) {
        const answer = exit.value
        yield* record(
          answer.value === undefined ? "invalid_output" : "success",
          answer.usage,
          answer.truncated ? "Truncated at the output token limit" : null
        )
        return { text: answer.text, value: answer.value, truncated: answer.truncated } satisfies RawAnswer
      }
      const failure = Cause.findErrorOption(exit.cause)
      // No typed failure: only defects or interruption, propagated as they are.
      if (failure._tag === "None") return yield* Effect.failCause(exit.cause as Cause.Cause<never>)
      const error = failure.value
      if (Cause.isTimeoutError(error)) {
        yield* record("timeout", undefined, "Timeout")
        return yield* new AiError({ kind: "timeout", message: "Il modello non ha risposto in tempo", retryable: true })
      }
      yield* record("error", undefined, describeError(error))
      return yield* new AiError({
        kind: "provider",
        message: `Errore del modello (${describeError(error)})`,
        // Bad requests (4xx other than 408/429) cannot be fixed by retrying.
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

  const generateObject = <S extends OutputSchema>(request: StructuredRequest<S>) =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownExit(Schema.toCodecJson(request.schema))
      const messages: Array<ModelMessage> = [{ role: "user", content: request.input }]

      const first = yield* call(request, messages, 1)
      const firstResult = decode(first.value)
      if (Exit.isSuccess(firstResult)) return firstResult.value

      // One correction request. A truncated answer is not shown back (it would not fit either):
      // the model is asked for a shorter one instead.
      if (first.truncated) {
        const shorter = yield* call(
          request,
          [
            {
              role: "user",
              content: `${request.input}\n\nImportant: a previous answer was cut off because it exceeded the output limit. Answer with a much shorter JSON object: fewer items, one short sentence each.`
            }
          ],
          2
        )
        const shorterResult = decode(shorter.value)
        if (Exit.isSuccess(shorterResult)) return shorterResult.value
        return yield* new AiError({
          kind: "invalid_output",
          message: "La risposta del modello supera il limite di token in uscita (AI_MAX_OUTPUT_TOKENS)",
          retryable: false
        })
      }
      // Otherwise the model sees its answer and what is wrong with it.
      const issues = Cause.findErrorOption(firstResult.cause)
      const description =
        first.value === undefined
          ? "The answer is not valid JSON."
          : issues._tag === "Some"
            ? issues.value.message.slice(0, MAX_REPAIR_ISSUES)
            : "The answer does not match the schema."
      const repaired = yield* call(
        request,
        [
          ...messages,
          { role: "assistant", content: first.text },
          {
            role: "user",
            content: `Your answer is not valid:\n${description}\n\nAnswer again with a single JSON object that matches the schema exactly.`
          }
        ],
        2
      )
      const repairedResult = decode(repaired.value)
      if (Exit.isSuccess(repairedResult)) return repairedResult.value
      return yield* new AiError({
        kind: "invalid_output",
        message: "Il modello ha prodotto una risposta non valida anche dopo la richiesta di correzione",
        retryable: false
      })
    }).pipe(Effect.withSpan("ai.generateObject", { attributes: { task: request.prompt.id, model: modelId } }))

  return LanguageModel.of({
    modelId,
    contextTokens: config.contextTokens,
    maxOutputTokens: config.maxOutputTokens,
    generateObject
  })
})
