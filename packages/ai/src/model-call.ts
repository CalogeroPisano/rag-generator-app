import { Context, type Effect, Schema } from "effect"

export const ModelCallOutcome = Schema.Literals(["success", "invalid_output", "error", "timeout"])
export type ModelCallOutcome = typeof ModelCallOutcome.Type

/** Who asked for a model call: copied into the call log. */
export interface ModelCallContext {
  readonly phase: string
  readonly jobId?: string | undefined
  readonly snapshotId?: string | undefined
}

/**
 * One HTTP call to a model, as recorded in the call log. Metadata only: the
 * prompt and the output are never recorded (they contain source code).
 */
export interface ModelCall extends ModelCallContext {
  /** Prompt id, e.g. `file-summary`. */
  readonly task: string
  readonly promptVersion: number
  readonly provider: string
  readonly model: string
  /** 1 for the first call, 2 for the correction request after an invalid output. */
  readonly attempt: number
  readonly outcome: ModelCallOutcome
  readonly durationMs: number
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  /** Short error description (error name, HTTP status); never response bodies. */
  readonly error: string | null
}

/** Sink of the model call log, implemented by the database layer. */
export class ModelCallRecorder extends Context.Service<
  ModelCallRecorder,
  {
    record(call: ModelCall): Effect.Effect<void>
  }
>()("code-to-rag/ai/ModelCallRecorder") {}
