import {
  acquisitionPipeline,
  analysisPipeline,
  cardPipeline,
  evaluationPipeline,
  indexingPipeline,
  type Job,
  JobRepository,
  type JobType,
  questionsPipeline,
  removeStaleUploads,
  runJob,
  SnapshotRepository,
  understandingPipeline
} from "@code-to-rag/core"
import { Config, Deferred, Duration, Effect, Option, Schedule } from "effect"

export interface WorkerOptions {
  readonly workerId: string
  readonly concurrency: number
  readonly pollInterval: Duration.Duration
  readonly heartbeatInterval: Duration.Duration
  /** A running job whose heartbeat is older than this is considered abandoned. */
  readonly staleAfter: Duration.Duration
}

export const WorkerOptionsConfig = (workerId: string) =>
  Config.all({
    concurrency: Config.Int("WORKER_CONCURRENCY").pipe(Config.withDefault(2)),
    pollInterval: Config.Duration("WORKER_POLL_INTERVAL").pipe(Config.withDefault(Duration.seconds(2))),
    heartbeatInterval: Config.Duration("WORKER_HEARTBEAT_INTERVAL").pipe(Config.withDefault(Duration.seconds(15))),
    staleAfter: Config.Duration("WORKER_STALE_AFTER").pipe(Config.withDefault(Duration.minutes(2)))
  }).pipe(Config.map((options): WorkerOptions => ({ workerId, ...options })))

/** Pipeline for each job type; adding a job type without a pipeline is a type error. */
const pipelines = {
  acquisition: acquisitionPipeline,
  analysis: analysisPipeline,
  understanding: understandingPipeline,
  card: cardPipeline,
  indexing: indexingPipeline,
  questions: questionsPipeline,
  evaluation: evaluationPipeline
} as const satisfies Record<JobType, unknown>

/** Runs the pipeline of a job; each job type has its own pipeline (and service requirements). */
const runPipeline = Effect.fnUntraced(function* (job: Job) {
  switch (job.type) {
    case "acquisition":
      return yield* runJob(pipelines.acquisition, job)
    case "analysis":
      return yield* runJob(pipelines.analysis, job)
    case "understanding":
      return yield* runJob(pipelines.understanding, job)
    case "card":
      return yield* runJob(pipelines.card, job)
    case "indexing":
      return yield* runJob(pipelines.indexing, job)
    case "questions":
      return yield* runJob(pipelines.questions, job)
    case "evaluation":
      return yield* runJob(pipelines.evaluation, job)
  }
})

/**
 * Runs one job while a background fiber keeps its heartbeat fresh. When the
 * heartbeat finds that the job is no longer this run's (cancelled by a user,
 * or requeued and claimed again), the run is interrupted: two runs of the same
 * job never go on together.
 */
const processJob = Effect.fnUntraced(function* (job: Job, options: WorkerOptions) {
  const jobs = yield* JobRepository
  const lost = yield* Deferred.make<boolean>()
  yield* jobs.heartbeat(job.id, options.workerId, job.attempts).pipe(
    Effect.flatMap((owned) => (owned ? Effect.void : Deferred.succeed(lost, true))),
    // A failed heartbeat is retried at the next tick; logged, since a job without heartbeats looks abandoned.
    Effect.catch((error) =>
      Effect.logWarning("Heartbeat failed").pipe(Effect.annotateLogs({ jobId: job.id, operation: error.operation }))
    ),
    Effect.repeat(Schedule.spaced(options.heartbeatInterval)),
    Effect.forkScoped
  )
  yield* Effect.logInfo("Job started").pipe(
    Effect.annotateLogs({ jobId: job.id, type: job.type, attempt: job.attempts })
  )
  yield* runPipeline(job).pipe(
    Effect.raceFirst(
      Deferred.await(lost).pipe(
        Effect.andThen(
          Effect.logWarning("Job stopped: cancelled or taken over by another run").pipe(
            Effect.annotateLogs({ jobId: job.id, attempt: job.attempts })
          )
        )
      )
    )
  )
}, Effect.scoped)

/** One consumer: claims and runs jobs until interrupted. */
const consumer = (options: WorkerOptions) =>
  Effect.gen(function* () {
    const jobs = yield* JobRepository
    const next = yield* jobs.claim(options.workerId)
    if (Option.isNone(next)) return yield* Effect.sleep(options.pollInterval)
    yield* processJob(next.value, options)
  }).pipe(
    // A database outage must not kill the worker: log, wait, try again.
    Effect.catchTag("DatabaseError", (error) =>
      Effect.logError("Worker iteration failed", error.operation).pipe(
        Effect.andThen(Effect.sleep(options.pollInterval))
      )
    ),
    Effect.forever
  )

/** Periodic maintenance: requeue abandoned jobs, delete abandoned uploads. */
const maintenance = (options: WorkerOptions) =>
  Effect.gen(function* () {
    const jobs = yield* JobRepository
    const snapshots = yield* SnapshotRepository
    // This worker's own jobs are alive by definition: only other (dead) workers' jobs are requeued.
    const requeued = yield* jobs.requeueStale(
      new Date(Date.now() - Duration.toMillis(options.staleAfter)),
      options.workerId
    )
    if (requeued > 0) yield* Effect.logWarning("Requeued abandoned jobs").pipe(Effect.annotateLogs({ requeued }))
    const keep = new Set<string>(yield* snapshots.pendingUploadIds)
    yield* removeStaleUploads(Duration.toMillis(Duration.hours(24)), keep)
  }).pipe(
    Effect.catchCause((cause) => Effect.logError("Maintenance failed", cause)),
    Effect.repeat(Schedule.spaced(Duration.minutes(1)))
  )

export const runWorker = (options: WorkerOptions) =>
  Effect.gen(function* () {
    yield* Effect.logInfo("Worker started").pipe(
      Effect.annotateLogs({ workerId: options.workerId, concurrency: options.concurrency })
    )
    yield* Effect.forkScoped(maintenance(options))
    yield* Effect.forEach(
      Array.from({ length: options.concurrency }, (_, i) => i),
      () => consumer(options),
      {
        concurrency: "unbounded",
        discard: true
      }
    )
  }).pipe(Effect.scoped)
