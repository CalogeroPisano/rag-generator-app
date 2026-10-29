import { Config, Context, Duration, Effect, Layer } from "effect"

export interface DecisionConfigShape {
  /** Base URL of the Ollama server (without `/v1`). */
  readonly baseUrl: string
  /** Decision model (System One API), e.g. `d1-omni`. */
  readonly model: string
  /** Timeout of a single request. */
  readonly timeout: Duration.Duration
  /** Retries of a request that failed with a transient error (network, 429, 5xx, timeout). */
  readonly maxRetries: number
  /** Requests running at the same time in this process. */
  readonly concurrency: number
  /** Token budget of one request (state and questions): it must fit the model's context window. */
  readonly contextTokens: number
  /** Questions sent in one request (the API takes 1 to 64). */
  readonly maxQuestions: number
  /** How long Ollama keeps the model loaded after a request. */
  readonly keepAlive: string
}

/** Decision model configuration, read from `DECISION_*` environment variables. The model is always required. */
export class DecisionConfig extends Context.Service<DecisionConfig, DecisionConfigShape>()(
  "code-to-rag/ollama/DecisionConfig"
) {
  static readonly layer = Layer.effect(
    DecisionConfig,
    Effect.gen(function* () {
      return DecisionConfig.of({
        baseUrl: (yield* Config.String("DECISION_BASE_URL").pipe(Config.withDefault("http://localhost:11434")))
          .trim()
          .replace(/\/+$/, ""),
        model: (yield* Config.String("DECISION_MODEL").pipe(Config.withDefault("d1-omni"))).trim(),
        timeout: yield* Config.Duration("DECISION_TIMEOUT").pipe(Config.withDefault(Duration.minutes(2))),
        maxRetries: yield* Config.Int("DECISION_MAX_RETRIES").pipe(Config.withDefault(2)),
        concurrency: yield* Config.Int("DECISION_CONCURRENCY").pipe(Config.withDefault(1)),
        contextTokens: yield* Config.Int("DECISION_CONTEXT_TOKENS").pipe(Config.withDefault(12_000)),
        maxQuestions: Math.min(
          64,
          Math.max(2, yield* Config.Int("DECISION_MAX_QUESTIONS").pipe(Config.withDefault(64)))
        ),
        keepAlive: yield* Config.String("DECISION_KEEP_ALIVE").pipe(Config.withDefault("10m"))
      })
    })
  )
}
