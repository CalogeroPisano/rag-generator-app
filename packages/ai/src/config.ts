import { Config, Context, Duration, Effect, Layer, Option, Redacted } from "effect"

/** An optional setting: unset and empty (`AI_MODEL=` in a .env file) both mean "not configured". */
const optionalString = (name: string) =>
  Config.option(Config.String(name)).pipe(
    Config.map((value) => Option.getOrUndefined(Option.filter(value, (text) => text.trim() !== "")))
  )

export interface AiConfigShape {
  /** Base URL of an OpenAI-compatible API (Ollama: `http://host:11434/v1`, vLLM: `http://host:8000/v1`). */
  readonly baseUrl: string
  /** Provider name, used in logs and in the model call log (e.g. `ollama`, `vllm`). */
  readonly providerName: string
  /** Chat model id; undefined when the AI layer is not configured (understanding jobs then fail). */
  readonly model: string | undefined
  readonly apiKey: Redacted.Redacted | undefined
  /** Send the JSON schema as `response_format` (Ollama and vLLM support it); otherwise plain JSON mode. */
  readonly structuredOutputs: boolean
  /** Timeout of a single model call. */
  readonly timeout: Duration.Duration
  /** Retries of a call that failed with a transient error (network, 429, 5xx, timeout). */
  readonly maxRetries: number
  /** Model calls running at the same time in this process. */
  readonly concurrency: number
  /** Context window of the model, in tokens: prompts are sized to fit it. */
  readonly contextTokens: number
  readonly maxOutputTokens: number
  /** Output limit of a chat answer (RAG chat and test runs). */
  readonly chatMaxOutputTokens: number
  readonly temperature: number
  /** Embedding model (OpenAI-compatible `/embeddings`); undefined when not configured (no index, no chat). */
  readonly embedding: {
    readonly baseUrl: string
    readonly model: string | undefined
    readonly apiKey: Redacted.Redacted | undefined
    /** Texts sent in one embedding request. */
    readonly batchSize: number
  }
}

/** AI configuration, read from `AI_*` environment variables. */
export class AiConfig extends Context.Service<AiConfig, AiConfigShape>()("code-to-rag/ai/AiConfig") {
  static readonly layer = Layer.effect(
    AiConfig,
    Effect.gen(function* () {
      const apiKey = yield* optionalString("AI_API_KEY")
      const baseUrl = yield* Config.String("AI_BASE_URL").pipe(Config.withDefault("http://localhost:11434/v1"))
      // The embedding endpoint defaults to the chat one (same Ollama or vLLM server).
      const embeddingApiKey = (yield* optionalString("EMBEDDING_API_KEY")) ?? apiKey
      return AiConfig.of({
        baseUrl,
        providerName: yield* Config.String("AI_PROVIDER_NAME").pipe(Config.withDefault("openai-compatible")),
        model: (yield* optionalString("AI_MODEL"))?.trim(),
        apiKey: apiKey === undefined ? undefined : Redacted.make(apiKey),
        structuredOutputs: yield* Config.Boolean("AI_STRUCTURED_OUTPUTS").pipe(Config.withDefault(true)),
        timeout: yield* Config.Duration("AI_TIMEOUT").pipe(Config.withDefault(Duration.minutes(5))),
        maxRetries: yield* Config.Int("AI_MAX_RETRIES").pipe(Config.withDefault(2)),
        concurrency: yield* Config.Int("AI_CONCURRENCY").pipe(Config.withDefault(2)),
        contextTokens: yield* Config.Int("AI_CONTEXT_TOKENS").pipe(Config.withDefault(16_384)),
        maxOutputTokens: yield* Config.Int("AI_MAX_OUTPUT_TOKENS").pipe(Config.withDefault(4096)),
        chatMaxOutputTokens: yield* Config.Int("AI_CHAT_MAX_OUTPUT_TOKENS").pipe(Config.withDefault(1024)),
        temperature: yield* Config.Number("AI_TEMPERATURE").pipe(Config.withDefault(0.1)),
        embedding: {
          baseUrl: (yield* optionalString("EMBEDDING_BASE_URL"))?.trim() ?? baseUrl,
          model: (yield* optionalString("EMBEDDING_MODEL"))?.trim(),
          apiKey: embeddingApiKey === undefined ? undefined : Redacted.make(embeddingApiKey),
          batchSize: yield* Config.Int("EMBEDDING_BATCH_SIZE").pipe(Config.withDefault(16))
        }
      })
    })
  )
}
