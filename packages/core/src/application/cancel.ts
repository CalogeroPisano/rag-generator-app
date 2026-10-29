import { Effect } from "effect"
import { SourceWorkspace } from "../ports/outbound/source.ts"
import type { JobId } from "../domain/model.ts"
import {
  AnalysisRepository,
  EvaluationRepository,
  JobRepository,
  SnapshotRepository,
  UnderstandingRepository
} from "../ports/outbound/repositories.ts"

/**
 * Stops a job (user action, "Interrompi"). A queued job ends at once; a running
 * one is stopped by its worker at the next heartbeat, when it finds that the
 * job is no longer its own. What the job was producing is marked failed, as
 * when a job fails for good, so that the pages show it and "Riprendi" resumes
 * it from the interrupted phase (completed phases are kept).
 */
export const cancelJob = Effect.fn("cancelJob")(function* (jobId: JobId) {
  const jobs = yield* JobRepository
  const { job, cancelled } = yield* jobs.cancel(jobId)
  if (!cancelled) return job
  switch (job.type) {
    case "acquisition": {
      yield* (yield* SnapshotRepository).setStatus(job.snapshotId, "failed")
      yield* (yield* SourceWorkspace).remove(job.id)
      break
    }
    case "analysis":
      yield* (yield* AnalysisRepository).setStatus(job.snapshotId, "failed")
      break
    case "understanding":
      yield* (yield* UnderstandingRepository).setStatus(job.snapshotId, "failed")
      break
    case "evaluation":
      yield* (yield* EvaluationRepository).finishRun(job.id, "failed", null)
      break
    case "card":
    case "indexing":
    case "questions":
      // They store their output item by item: what was saved stays usable.
      break
  }
  yield* Effect.logInfo("Job cancelled").pipe(Effect.annotateLogs({ jobId: job.id, type: job.type }))
  return job
})
