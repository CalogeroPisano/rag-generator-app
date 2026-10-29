import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import {
  AiError,
  LanguageModel,
  type LanguageModelShape,
  type ModelCallContext,
  type ModelCallOutcome,
  ModelCallRecorder,
  type OutputSchema,
  type PromptRef,
  type StructuredRequest,
  type TextAnswer,
  type TextRequest
} from "@code-to-rag/core/outbound"
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
import { Cause, type Duration, Effect, Exit, Layer, Redacted, Schedule, Schema, Semaphore } from "effect"
import { AiConfig, type AiConfigShape } from "./config.ts"
import { modelFetch } from "./fetch.ts"

/**
 * Adapter of the `LanguageModel` port: AI SDK with the OpenAI-compatible provider, model from the `AI_*`
 * configuration. Without `AI_MODEL` every call fails with `not_configured`.
 */
export const LanguageModelLive = Layer.effect(
  LanguageModel,
  Effect.gen(function* () {
    const config = yield* AiConfig
    if (config.model === undefined) return notConfigured(config)
    const provider = createOpenAICompatible({
      name: config.providerName,
      baseURL: config.baseUrl,
      ...(config.apiKey === undefined ? {} : { apiKey: Redacted.value(config.apiKey) }),
      supportsStructuredOutputs: config.structuredOutputs,
      includeUsage: true,
      fetch: modelFetch
    })
    return yield* makeLanguageModel({ model: provider.chatModel(config.model), modelId: config.model, config })
  })
)

const notConfigured = (config: AiConfigShape): LanguageModelShape => {
  const fail = Effect.fail(
    new AiError({
      kind: "not_configured",
      message: "Modello IA non configurato (AI_MODEL)",
      retryable: false
    })
  )
  return {
    modelId: undefined,
    contextTokens: config.contextTokens,
    maxOutputTokens: config.maxOutputTokens,
    chatMaxOutputTokens: config.chatMaxOutputTokens,
    generateObject: () => fail,
    generateText: () => fail
  }
}

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

/** Streams a text answer, handing every delta to `onDelta`. */
const streamPlainText = async (options: Parameters<typeof streamText>[0], onDelta: (delta: string) => void) => {
  let failure: { readonly error: unknown } | undefined
  const result = streamText({ ...options, onError: () => undefined })
  for await (const part of result.stream) {
    if (part.type === "error") failure ??= { error: part.error }
    else if (part.type === "text-delta" && part.text !== "") onDelta(part.text)
  }
  if (failure !== undefined) throw failure.error
  const [text, usage, finishReason] = await Promise.all([result.text, result.usage, result.finishReason])
  return { text, usage, truncated: finishReason === "length" }
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

  type Usage = { readonly inputTokens: number | undefined; readonly outputTokens: number | undefined }

  /**
   * One HTTP call, recorded in the call log whatever its outcome, under the
   * concurrency limit, with retries of transient errors (unless `retryable`
   * says the call must not be repeated, e.g. part of a chat answer was shown).
   */
  const runCall = <A extends { readonly usage: Usage | undefined }>(
    meta: { readonly prompt: PromptRef; readonly context: ModelCallContext; readonly attempt: number },
    run: (signal: AbortSignal) => Promise<A>,
    describe: (value: A) => { readonly outcome: ModelCallOutcome; readonly error: string | null },
    retryable: () => boolean = () => true
  ) =>
    Effect.gen(function* () {
      const startedAt = Date.now()
      const exit = yield* Effect.tryPromise({ try: run, catch: (error) => error }).pipe(
        Effect.timeout(config.timeout),
        Effect.exit
      )

      const record = (outcome: ModelCallOutcome, usage: Usage | undefined, error: string | null) =>
        recorder.record({
          ...meta.context,
          task: meta.prompt.id,
          promptVersion: meta.prompt.version,
          provider: config.providerName,
          model: modelId,
          attempt: meta.attempt,
          outcome,
          durationMs: Date.now() - startedAt,
          inputTokens: usage?.inputTokens ?? null,
          outputTokens: usage?.outputTokens ?? null,
          error
        })

      if (Exit.isSuccess(exit)) {
        const { outcome, error } = describe(exit.value)
        yield* record(outcome, exit.value.usage, error)
        return exit.value
      }
      const failure = Cause.findErrorOption(exit.cause)
      // No typed failure: only defects or interruption, propagated as they are.
      if (failure._tag === "None") return yield* Effect.failCause(exit.cause as Cause.Cause<never>)
      const error = failure.value
      if (Cause.isTimeoutError(error)) {
        yield* record("timeout", undefined, "Timeout")
        return yield* new AiError({
          kind: "timeout",
          message: "Il modello non ha risposto in tempo",
          retryable: retryable()
        })
      }
      yield* record("error", undefined, describeError(error))
      return yield* new AiError({
        kind: "provider",
        message: `Errore del modello (${describeError(error)})`,
        // Bad requests (4xx other than 408/429) cannot be fixed by retrying.
        retryable: (APICallError.isInstance(error) ? error.isRetryable : true) && retryable()
      })
    }).pipe(
      semaphore.withPermits(1),
      Effect.retry({
        schedule: Schedule.exponential(options.retryBaseDelay ?? "2 seconds"),
        times: config.maxRetries,
        while: (error) => error.retryable
      })
    )

  /** One structured call: the raw answer, parsed but not validated yet. */
  const call = <S extends OutputSchema>(
    request: StructuredRequest<S>,
    messages: Array<ModelMessage>,
    attempt: number
  ): Effect.Effect<RawAnswer, AiError> =>
    runCall(
      { prompt: request.prompt, context: request.context, attempt },
      (signal) =>
        streamAnswer({
          model,
          instructions: request.instructions,
          messages,
          output: Output.object({ schema: jsonSchema(toModelJsonSchema(request.schema)) }),
          maxOutputTokens: request.maxOutputTokens ?? config.maxOutputTokens,
          temperature: config.temperature,
          // Retries are handled by runCall, with the call log and the concurrency limit.
          maxRetries: 0,
          abortSignal: signal
        }),
      (answer) => ({
        outcome: answer.value === undefined ? "invalid_output" : "success",
        error: answer.truncated ? "Truncated at the output token limit" : null
      })
    ).pipe(Effect.map((answer) => ({ text: answer.text, value: answer.value, truncated: answer.truncated })))

  const generateText = (request: TextRequest) =>
    Effect.suspend(() => {
      let delivered = false
      const onDelta = (delta: string) => {
        delivered = true
        request.onDelta?.(delta)
      }
      return runCall(
        { prompt: request.prompt, context: request.context, attempt: 1 },
        (signal) =>
          streamPlainText(
            {
              model,
              instructions: request.instructions,
              messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
              maxOutputTokens: request.maxOutputTokens ?? config.chatMaxOutputTokens,
              temperature: config.temperature,
              maxRetries: 0,
              abortSignal: signal
            },
            onDelta
          ),
        (answer) => ({
          outcome: "success",
          error: answer.truncated ? "Truncated at the output token limit" : null
        }),
        () => !delivered
      )
    }).pipe(
      Effect.map((answer): TextAnswer => ({ text: answer.text, truncated: answer.truncated })),
      Effect.withSpan("ai.generateText", { attributes: { task: request.prompt.id, model: modelId } })
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
    chatMaxOutputTokens: config.chatMaxOutputTokens,
    generateObject,
    generateText
  })
})
