import { JobEventsListener } from "@code-to-rag/core/outbound"
import { Effect, Layer, PubSub, Schedule } from "effect"
import type pg from "pg"
import { Database } from "./client.ts"
import { JOB_EVENTS_CHANNEL } from "./job-repository.ts"

/**
 * Wakes up waiters when the worker records a job event. One dedicated
 * connection runs `LISTEN job_events`; notifications are fanned out in
 * process. If the connection drops it is re-established in the background,
 * and waiters fall back to their timeout, so callers must re-check the DB
 * after every wake-up (notifications are hints, the table is the truth).
 */
export const JobEventsListenerLive = Layer.effect(
  JobEventsListener,
  Effect.gen(function* () {
    const { pool } = yield* Database
    const notifications = yield* PubSub.unbounded<string>()

    const connect = Effect.tryPromise(async () => {
      const client: pg.PoolClient = await pool.connect()
      const closed = new Promise<void>((resolve) => {
        client.on("error", () => resolve())
        client.on("end", () => resolve())
      })
      client.on("notification", (message) => {
        if (message.channel === JOB_EVENTS_CHANNEL && message.payload !== undefined) {
          PubSub.publishUnsafe(notifications, message.payload)
        }
      })
      await client.query(`LISTEN ${JOB_EVENTS_CHANNEL}`)
      return { client, closed }
    })

    // Keep one listening connection alive for the lifetime of the layer.
    yield* Effect.gen(function* () {
      const { client, closed } = yield* connect
      yield* Effect.promise(() => closed).pipe(Effect.ensuring(Effect.sync(() => client.release(true))))
    }).pipe(Effect.ignore, Effect.repeat(Schedule.spaced("2 seconds")), Effect.forkScoped)

    return JobEventsListener.of({
      waitFor: (jobId, timeout) =>
        Effect.scoped(
          Effect.gen(function* () {
            const subscription = yield* PubSub.subscribe(notifications)
            yield* PubSub.take(subscription).pipe(
              Effect.repeat({ until: (payload) => payload === jobId }),
              Effect.timeoutOption(timeout),
              Effect.asVoid
            )
          })
        )
    })
  })
)
