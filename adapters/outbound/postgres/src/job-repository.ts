import { JobId, JobRepository, type JobEventKind, type JobProgress, NotFoundError } from "@code-to-rag/core/outbound"
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm"
import type { PgUpdateSetSource } from "drizzle-orm/pg-core"
import { Effect, Layer, Option } from "effect"
import { Database, type Drizzle, query } from "./client.ts"
import { jobFromRow, jobEventFromRow } from "./rows.ts"
import { job, jobEvent } from "./schema/app.ts"

/** Channel used to wake up SSE listeners; the payload is the job id. */
export const JOB_EVENTS_CHANNEL = "job_events"

type Executor = Pick<Drizzle, "insert" | "execute">

/** Appends an event and notifies listeners (delivered when the transaction commits). */
export const appendJobEvent = (
  executor: Executor,
  jobId: string,
  kind: JobEventKind,
  details: { phase?: string | null; message?: string | null; progress?: JobProgress | null } = {}
) =>
  executor
    .insert(jobEvent)
    .values({
      jobId,
      kind,
      phase: details.phase ?? null,
      message: details.message ?? null,
      progress: details.progress ?? null
    })
    .then(() => executor.execute(sql`select pg_notify(${JOB_EVENTS_CHANNEL}, ${jobId})`))

export const JobRepositoryLive = Layer.effect(
  JobRepository,
  Effect.gen(function* () {
    const { db } = yield* Database

    /**
     * Runs an update on the job and records the matching event in one transaction. With `attempt`, only the run
     * that holds that claim may change the job (fencing): a run whose job was requeued, cancelled or claimed again
     * changes nothing.
     */
    const transition = (
      operation: string,
      id: JobId,
      kind: JobEventKind,
      values: PgUpdateSetSource<typeof job>,
      details: { phase?: string | null; message?: string | null; progress?: JobProgress | null } = {},
      attempt?: number
    ) =>
      query(operation, () =>
        db.transaction(async (tx) => {
          const updated = await tx
            .update(job)
            .set(values)
            .where(
              attempt === undefined
                ? eq(job.id, id)
                : and(eq(job.id, id), eq(job.status, "running"), eq(job.attempts, attempt))
            )
            .returning({ id: job.id })
          if (updated.length > 0) await appendJobEvent(tx, id, kind, details)
        })
      )

    const get = Effect.fnUntraced(function* (id: JobId) {
      const rows = yield* query("job.get", () => db.select().from(job).where(eq(job.id, id)))
      const row = rows[0]
      if (row === undefined) return yield* new NotFoundError({ entity: "job", id })
      return yield* jobFromRow(row)
    })

    return JobRepository.of({
      enqueue: Effect.fnUntraced(function* (input) {
        const id = yield* query("job.enqueue", () =>
          db.transaction(async (tx) => {
            // Serialises concurrent enqueues for the same snapshot.
            await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.snapshotId}::text))`)
            const [active] = await tx
              .select({ id: job.id })
              .from(job)
              .where(
                and(
                  eq(job.snapshotId, input.snapshotId),
                  eq(job.type, input.type),
                  input.dedupeKey === undefined ? isNull(job.dedupeKey) : eq(job.dedupeKey, input.dedupeKey),
                  inArray(job.status, input.dedupe === "queued" ? ["queued"] : ["queued", "running"])
                )
              )
            if (active !== undefined) return active.id
            await tx.insert(job).values({
              id: input.id,
              type: input.type,
              projectId: input.projectId,
              snapshotId: input.snapshotId,
              status: "queued",
              maxAttempts: input.maxAttempts,
              payload: input.payload ?? null,
              dedupeKey: input.dedupeKey ?? null
            })
            await appendJobEvent(tx, input.id, "queued")
            return input.id
          })
        )
        return yield* get(JobId.make(id)).pipe(Effect.catchTag("NotFoundError", Effect.die))
      }),

      active: (projectId) =>
        query("job.active", () =>
          db
            .select()
            .from(job)
            .where(and(eq(job.projectId, projectId), inArray(job.status, ["queued", "running"])))
            .orderBy(asc(job.createdAt))
        ).pipe(Effect.flatMap((rows) => Effect.forEach(rows, jobFromRow))),

      claim: Effect.fnUntraced(function* (workerId: string) {
        const claimedId = yield* query("job.claim", () =>
          db.transaction(async (tx) => {
            const claimed = await tx.execute<{ id: string; attempts: number }>(sql`
              update ${job}
              set status = 'running', locked_by = ${workerId}, heartbeat_at = now(),
                  attempts = attempts + 1, updated_at = now()
              where id = (
                select id from ${job}
                where status = 'queued' and run_after <= now()
                order by run_after, created_at
                for update skip locked
                limit 1
              )
              returning id, attempts`)
            const row = claimed.rows[0]
            if (row === undefined) return undefined
            await appendJobEvent(tx, row.id, "started", { message: `Tentativo ${row.attempts}` })
            return row.id
          })
        )
        if (claimedId === undefined) return Option.none()
        return yield* get(JobId.make(claimedId)).pipe(
          Effect.map(Option.some),
          Effect.catchTag("NotFoundError", () => Effect.succeed(Option.none()))
        )
      }),

      heartbeat: (id, workerId, attempt) =>
        query("job.heartbeat", () =>
          db
            .update(job)
            .set({ heartbeatAt: new Date() })
            .where(
              and(eq(job.id, id), eq(job.lockedBy, workerId), eq(job.status, "running"), eq(job.attempts, attempt))
            )
            .returning({ id: job.id })
        ).pipe(Effect.map((rows) => rows.length > 0)),

      startPhase: (id, phase) =>
        transition("job.startPhase", id, "phase_started", { currentPhase: phase, progress: null }, { phase }),

      completePhase: (id, phase) =>
        transition(
          "job.completePhase",
          id,
          "phase_completed",
          {
            completedPhases: sql`case when ${phase} = any(${job.completedPhases}) then ${job.completedPhases}
              else array_append(${job.completedPhases}, ${phase}::text) end`
          },
          { phase }
        ),

      reportProgress: (id, progress) =>
        transition("job.reportProgress", id, "progress", { progress }, { phase: progress.phase, progress }),

      succeed: (id, attempt) =>
        transition(
          "job.succeed",
          id,
          "succeeded",
          { status: "succeeded", currentPhase: null, lockedBy: null, lastError: null, finishedAt: new Date() },
          {},
          attempt
        ),

      fail: (id, message, attempt) =>
        transition(
          "job.fail",
          id,
          "failed",
          { status: "failed", lockedBy: null, lastError: message, finishedAt: new Date() },
          { message },
          attempt
        ),

      scheduleRetry: (id, message, runAfter, attempt) =>
        transition(
          "job.scheduleRetry",
          id,
          "retry_scheduled",
          { status: "queued", lockedBy: null, lastError: message, runAfter },
          { message: `${message} — nuovo tentativo alle ${runAfter.toISOString()}` },
          attempt
        ),

      release: (id, attempt) =>
        transition(
          "job.release",
          id,
          "queued",
          { status: "queued", lockedBy: null, attempts: sql`greatest(${job.attempts} - 1, 0)`, runAfter: new Date() },
          { message: "Worker arrestato: job rimesso in coda" },
          attempt
        ),

      cancel: Effect.fnUntraced(function* (id) {
        const current = yield* get(id)
        if (current.status !== "queued" && current.status !== "running") return { job: current, cancelled: false }
        // A running job is stopped by its worker at the next heartbeat (it no longer owns it).
        yield* transition(
          "job.cancel",
          id,
          "cancelled",
          { status: "cancelled", lockedBy: null, finishedAt: new Date() },
          { message: "Interrotto dall'utente" }
        )
        return { job: yield* get(id), cancelled: true }
      }),

      requeueStale: (heartbeatBefore, exceptWorkerId) =>
        query("job.requeueStale", () =>
          db.transaction(async (tx) => {
            const stale = await tx.execute<{ id: string; status: string }>(sql`
              update ${job}
              set status = case when attempts >= max_attempts then 'failed' else 'queued' end,
                  last_error = 'Il worker ha smesso di rispondere',
                  finished_at = case when attempts >= max_attempts then now() else null end,
                  locked_by = null, updated_at = now()
              where status = 'running' and heartbeat_at < ${heartbeatBefore.toISOString()}::timestamptz
                and (${exceptWorkerId ?? null}::text is null or locked_by is distinct from ${exceptWorkerId ?? null}::text)
              returning id, status`)
            for (const row of stale.rows) {
              await appendJobEvent(tx, row.id, row.status === "failed" ? "failed" : "queued", {
                message: "Il worker ha smesso di rispondere"
              })
            }
            return stale.rows.length
          })
        ),

      retry: Effect.fnUntraced(function* (id: JobId) {
        const current = yield* get(id)
        if (current.status !== "failed" && current.status !== "cancelled") return current
        yield* transition(
          "job.retry",
          id,
          "queued",
          { status: "queued", attempts: 0, lastError: null, finishedAt: null, runAfter: new Date() },
          { message: "Nuovo tentativo manuale" }
        )
        return yield* get(id)
      }),

      get,

      eventsAfter: (id, afterEventId) =>
        query("job.eventsAfter", () =>
          db
            .select()
            .from(jobEvent)
            .where(and(eq(jobEvent.jobId, id), gt(jobEvent.id, afterEventId)))
            .orderBy(asc(jobEvent.id))
            .limit(500)
        ).pipe(Effect.flatMap((rows) => Effect.forEach(rows, jobEventFromRow)))
    })
  })
)
