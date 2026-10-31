import type { Duration } from "effect"

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
