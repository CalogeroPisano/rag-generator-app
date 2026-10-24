/** Payloads of the job SSE stream (`/api/jobs/$jobId/events`). Shared by server and client. */

export interface JobProgressWire {
  readonly phase: string
  readonly completed: number
  readonly total: number | null
  readonly message: string | null
}

export interface JobStateWire {
  readonly id: string
  readonly type: "acquisition" | "analysis" | "understanding" | "card"
  readonly status: "queued" | "running" | "succeeded" | "failed" | "cancelled"
  readonly currentPhase: string | null
  readonly completedPhases: ReadonlyArray<string>
  readonly attempts: number
  readonly maxAttempts: number
  readonly lastError: string | null
  readonly progress: JobProgressWire | null
}

export interface JobEventWire {
  readonly id: number
  readonly kind: string
  readonly phase: string | null
  readonly message: string | null
  readonly progress: JobProgressWire | null
  readonly createdAt: string
}

export const isTerminal = (status: JobStateWire["status"]) =>
  status === "succeeded" || status === "failed" || status === "cancelled"
