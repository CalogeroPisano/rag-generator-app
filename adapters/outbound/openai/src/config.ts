import type { Duration } from "effect"

/** Limits of the calls of one model, from the resolved model settings (`LanguageModelConfig` and friends). */
export interface AiConfigShape {
  /** Provider name recorded in the model call log (the connection's name). */
  readonly providerName: string
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
  /** Texts sent in one embedding request. */
  readonly batchSize: number
}
