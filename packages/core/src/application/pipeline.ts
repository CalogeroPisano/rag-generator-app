/**
 * Job pipeline: a job is an ordered list of named phases.
 *
 * Contract of a phase (kept so that phases can later become activities of
 * Effect's durable workflows without rewriting them):
 * - it is identified by a stable `name`;
 * - its only input is the job (ids); everything else is read from the DB;
 * - it is idempotent: running it again after a partial run gives the same
 *   result (it clears or overwrites what a previous attempt produced);
 * - its output is persisted before it returns.
 *
 * The runner records each completed phase, so a failed job resumes from the
 * phase that failed.
 */
import { Cause, Duration, Effect } from "effect"
import type { Job, JobProgress, JobType } from "../domain/model.ts"
import type { DatabaseError } from "../domain/errors.ts"
import { PhaseError } from "../domain/errors.ts"
import { JobRepository } from "../ports/outbound/repositories.ts"

export interface PhaseContext {
  readonly job: Job
  readonly progress: (progress: Omit<JobProgress, "phase">) => Effect.Effect<void, DatabaseError>
}

export interface Phase<R> {
  readonly name: string
  readonly run: (context: PhaseContext) => Effect.Effect<void, PhaseError, R>
}

export interface Pipeline<R> {
  readonly type: JobType
  readonly phases: ReadonlyArray<Phase<R>>
  /** Called once when the job fails for good (no retries left). */
  readonly onFailed: (job: Job) => Effect.Effect<void, never, R>
}

export const retryDelay = (attempt: number): Duration.Duration =>
  Duration.seconds(Math.min(30 * 2 ** Math.max(0, attempt - 1), 15 * 60))

const failJob = Effect.fnUntraced(function* <R>(pipeline: Pipeline<R>, job: Job, error: PhaseError) {
  const jobs = yield* JobRepository
  const message = `${error.phase}: ${error.message}`
  if (error.retryable && job.attempts < job.maxAttempts) {
    const runAfter = new Date(Date.now() + Duration.toMillis(retryDelay(job.attempts)))
    yield* jobs.scheduleRetry(job.id, message, runAfter, job.attempts)
    yield* Effect.logWarning("Job phase failed, retry scheduled").pipe(
      Effect.annotateLogs({ jobId: job.id, phase: error.phase, attempt: job.attempts })
    )
  } else {
    yield* jobs.fail(job.id, message, job.attempts)
    yield* pipeline.onFailed(job)
    yield* Effect.logError("Job failed").pipe(Effect.annotateLogs({ jobId: job.id, phase: error.phase }))
  }
})

/** Runs the phases of `job` that are not completed yet. */
export const runJob = Effect.fn("runJob")(function* <R>(pipeline: Pipeline<R>, job: Job) {
  const jobs = yield* JobRepository
  const remaining = pipeline.phases.filter((phase) => !job.completedPhases.includes(phase.name))
  let currentPhase = "setup"

  const execute = Effect.gen(function* () {
    for (const phase of remaining) {
      currentPhase = phase.name
      yield* jobs.startPhase(job.id, phase.name)
      yield* phase
        .run({
          job,
          progress: (progress) => jobs.reportProgress(job.id, { phase: phase.name, ...progress })
        })
        .pipe(Effect.withSpan(`phase.${phase.name}`), Effect.annotateLogs({ jobId: job.id, phase: phase.name }))
      yield* jobs.completePhase(job.id, phase.name)
    }
    yield* jobs.succeed(job.id, job.attempts)
  })

  yield* execute.pipe(
    Effect.catchTag("DatabaseError", (error) =>
      Effect.fail(
        new PhaseError({ phase: currentPhase, message: `Errore del database (${error.operation})`, retryable: true })
      )
    ),
    Effect.catchTag("PhaseError", (error) => failJob(pipeline, job, error)),
    // Bugs and unexpected exceptions: log the cause server-side, keep the job retryable.
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logError("Unexpected error while running job", cause).pipe(
            Effect.andThen(
              failJob(
                pipeline,
                job,
                new PhaseError({ phase: currentPhase, message: "Errore imprevisto", retryable: true })
              )
            )
          )
    ),
    // Worker shutdown: give the job back without consuming the attempt. A run stopped because it lost the job
    // (cancelled, requeued) changes nothing: the release is fenced by its attempt.
    Effect.onInterrupt(() => jobs.release(job.id, job.attempts).pipe(Effect.ignore))
  )
})
