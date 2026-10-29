/**
 * Jobs seen from the outside: their state and events (pages, progress stream)
 * and the operations of the worker loop (claim, heartbeat, run, maintenance).
 */
import { Duration, Effect } from "effect"
import type { Job, JobId, JobType, ProjectId } from "../domain/model.ts"
import { JobEventsListener } from "../ports/outbound/job-events.ts"
import { JobRepository, SnapshotRepository } from "../ports/outbound/repositories.ts"
import { acquisitionPipeline } from "./acquisition.ts"
import { analysisPipeline } from "./analysis.ts"
import { runJob } from "./pipeline.ts"
import { evaluationPipeline, questionsPipeline } from "./rag/evaluation.ts"
import { indexingPipeline } from "./rag/indexing.ts"
import { cardPipeline } from "./review.ts"
import { understandingPipeline } from "./understanding/pipeline.ts"
import { removeStaleUploads } from "./uploads.ts"

export const getJob = (jobId: JobId) => JobRepository.use((jobs) => jobs.get(jobId))

/** Manual retry of a failed job ("Riprova", "Riprendi"): it resumes from the failed phase. */
export const retryJob = (jobId: JobId) => JobRepository.use((jobs) => jobs.retry(jobId))

/** Queued and running jobs of a project. */
export const listActiveJobs = (projectId: ProjectId) => JobRepository.use((jobs) => jobs.active(projectId))

export const jobEventsAfter = (jobId: JobId, afterEventId: number) =>
  JobRepository.use((jobs) => jobs.eventsAfter(jobId, afterEventId))

/** Completes at the next event of the job or after `timeout`: read the events again either way. */
export const waitForJobEvent = (jobId: JobId, timeout: Duration.Input) =>
  JobEventsListener.use((listener) => listener.waitFor(jobId, timeout))

// ── Worker loop ──

/** Atomically takes the oldest runnable job. */
export const claimJob = (workerId: string) => JobRepository.use((jobs) => jobs.claim(workerId))

/** Refreshes the heartbeat of a run; false when the job is no longer this run's (cancelled, claimed again). */
export const heartbeatJob = (job: Job, workerId: string) =>
  JobRepository.use((jobs) => jobs.heartbeat(job.id, workerId, job.attempts))

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

/** Runs the pipeline of a claimed job; each job type has its own pipeline (and service requirements). */
export const runClaimedJob = Effect.fnUntraced(function* (job: Job) {
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
 * Periodic maintenance: requeues the jobs of workers that stopped sending heartbeats (never the caller's own: its
 * process is alive) and deletes uploads never attached to a project.
 */
export const runMaintenance = Effect.fn("runMaintenance")(function* (workerId: string, staleAfter: Duration.Duration) {
  const jobs = yield* JobRepository
  const snapshots = yield* SnapshotRepository
  const requeued = yield* jobs.requeueStale(new Date(Date.now() - Duration.toMillis(staleAfter)), workerId)
  if (requeued > 0) yield* Effect.logWarning("Requeued abandoned jobs").pipe(Effect.annotateLogs({ requeued }))
  const keep = new Set<string>(yield* snapshots.pendingUploadIds)
  yield* removeStaleUploads(Duration.toMillis(Duration.hours(24)), keep)
})
