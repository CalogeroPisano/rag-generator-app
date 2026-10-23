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
  readonly temperature: number
}

/** AI configuration, read from `AI_*` environment variables. */
export class AiConfig extends Context.Service<AiConfig, AiConfigShape>()("code-to-rag/ai/AiConfig") {
  static readonly layer = Layer.effect(
    AiConfig,
    Effect.gen(function* () {
      const apiKey = yield* optionalString("AI_API_KEY")
      return AiConfig.of({
        baseUrl: yield* Config.String("AI_BASE_URL").pipe(Config.withDefault("http://localhost:11434/v1")),
        providerName: yield* Config.String("AI_PROVIDER_NAME").pipe(Config.withDefault("openai-compatible")),
        model: (yield* optionalString("AI_MODEL"))?.trim(),
        apiKey: apiKey === undefined ? undefined : Redacted.make(apiKey),
        structuredOutputs: yield* Config.Boolean("AI_STRUCTURED_OUTPUTS").pipe(Config.withDefault(true)),
        timeout: yield* Config.Duration("AI_TIMEOUT").pipe(Config.withDefault(Duration.minutes(5))),
        maxRetries: yield* Config.Int("AI_MAX_RETRIES").pipe(Config.withDefault(2)),
        concurrency: yield* Config.Int("AI_CONCURRENCY").pipe(Config.withDefault(2)),
        contextTokens: yield* Config.Int("AI_CONTEXT_TOKENS").pipe(Config.withDefault(16_384)),
        maxOutputTokens: yield* Config.Int("AI_MAX_OUTPUT_TOKENS").pipe(Config.withDefault(4096)),
        temperature: yield* Config.Number("AI_TEMPERATURE").pipe(Config.withDefault(0.1))
      })
    })
  )
}
