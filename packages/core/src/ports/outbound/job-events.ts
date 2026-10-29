import { Context, type Duration, type Effect } from "effect"

/**
 * Wakes up waiters when a job event is recorded (implemented with Postgres `LISTEN/NOTIFY` by `@code-to-rag/postgres`).
 * Notifications are hints: after every wake-up, or timeout, callers read the job events again.
 */
export class JobEventsListener extends Context.Service<
  JobEventsListener,
  {
    /** Completes when an event for `jobId` is notified, or after `timeout`. */
    waitFor(jobId: string, timeout: Duration.Input): Effect.Effect<void>
  }
>()("code-to-rag/core/JobEventsListener") {}
