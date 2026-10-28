/**
 * New versions of a project's code (phase 6).
 *
 * "Nuova versione" creates a snapshot based on the current one and queues its
 * acquisition. A version identical to its base is discarded at the end of the
 * acquisition. After the static analysis, a version whose base has cards is
 * updated by an `understanding` job with `{ baseSnapshotId }` (unchanged
 * summaries and cards are copied, the rest is written again); otherwise it
 * becomes current at once. When it becomes current, versions beyond
 * `SNAPSHOT_RETENTION` are deleted.
 */
import { Effect } from "effect"
import { randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import { uploadPath } from "./acquisition.ts"
import { AppConfig } from "./config.ts"
import { JobId, type ProjectId, type Snapshot, SnapshotId, type UpdateJobPayload, type UploadId } from "./domain.ts"
import { InvalidInputError } from "./errors.ts"
import {
  JobRepository,
  KnowledgeRepository,
  ProjectRepository,
  SnapshotRepository,
  UnderstandingRepository
} from "./ports.ts"
import { diffFiles } from "./understanding/update.ts"
import { ensureUploadExists } from "./uploads.ts"

/** Queues the acquisition of a new version: a new archive (zip projects) or the latest commit of the branch (Git). */
export const requestNewVersion = Effect.fn("requestNewVersion")(function* (
  projectId: ProjectId,
  uploadId: UploadId | null
) {
  const config = yield* AppConfig
  const projects = yield* ProjectRepository
  const jobs = yield* JobRepository
  const { project, currentSnapshot } = yield* projects.get(projectId)
  if (project.sourceType === "zip") {
    if (uploadId === null) return yield* new InvalidInputError({ message: "Carica l'archivio della nuova versione" })
    yield* ensureUploadExists(uploadId)
  } else if (uploadId !== null) {
    return yield* new InvalidInputError({ message: "Il progetto usa un repository Git: non serve un archivio" })
  }
  // The update copies the cards of the current version: nothing else may be changing them.
  const active = yield* jobs.active(projectId)
  if (active.some((job) => job.type !== "indexing")) {
    return yield* new InvalidInputError({ message: "Attendi la fine delle operazioni in corso sul progetto" })
  }
  return yield* projects.createSnapshot({
    projectId,
    snapshotId: SnapshotId.make(randomUUID()),
    baseSnapshotId: currentSnapshot?.status === "ready" ? currentSnapshot.id : null,
    uploadId,
    jobId: JobId.make(randomUUID()),
    maxAttempts: config.jobMaxAttempts
  })
})

/**
 * Review, corrections and test questions act on the current version. They are
 * refused while a new version is being acquired or updated: its update reads
 * the current cards and the changes would not reach it.
 */
export const ensureNotUpdating = Effect.fnUntraced(function* (projectId: ProjectId) {
  const projects = yield* ProjectRepository
  const jobs = yield* JobRepository
  const { currentSnapshot } = yield* projects.get(projectId)
  const active = yield* jobs.active(projectId)
  if (active.some((job) => job.snapshotId !== currentSnapshot?.id)) {
    return yield* new InvalidInputError({
      message: "È in corso l'aggiornamento a una nuova versione del codice: riprova al termine"
    })
  }
})

const sameRevision = (a: Snapshot, b: Snapshot): boolean =>
  (a.commitSha !== null && a.commitSha === b.commitSha) || (a.contentHash !== null && a.contentHash === b.contentHash)

/** The base of a new version when both have the same revision (same commit, or same content for zips). */
export const unchangedBase = Effect.fnUntraced(function* (snapshotId: SnapshotId) {
  const snapshots = yield* SnapshotRepository
  const { snapshot } = yield* snapshots.get(snapshotId)
  if (snapshot.baseSnapshotId === null) return undefined
  const base = yield* snapshots.get(snapshot.baseSnapshotId).pipe(
    Effect.map((found) => found.snapshot),
    Effect.catchTag("NotFoundError", () => Effect.succeed(undefined))
  )
  return base !== undefined && sameRevision(snapshot, base) ? base : undefined
})

/** Queues the incremental update of a new version from its base. */
export const requestUpdate = Effect.fn("requestUpdate")(function* (snapshotId: SnapshotId, baseSnapshotId: SnapshotId) {
  const config = yield* AppConfig
  const jobs = yield* JobRepository
  const snapshots = yield* SnapshotRepository
  const understanding = yield* UnderstandingRepository
  const { snapshot } = yield* snapshots.get(snapshotId)
  const job = yield* jobs.enqueue({
    id: JobId.make(randomUUID()),
    type: "understanding",
    projectId: snapshot.projectId,
    snapshotId,
    maxAttempts: config.jobMaxAttempts,
    payload: { baseSnapshotId } satisfies UpdateJobPayload
  })
  if (job.status === "queued") yield* understanding.setStatus(snapshotId, "pending")
  return job
})

/**
 * Deletes the versions of a project beyond `SNAPSHOT_RETENTION`: the current
 * version and the newest complete older ones are kept, as are versions with
 * active jobs and versions newer than the current one (a failed update can be
 * retried). Incomplete older versions are deleted.
 */
export const pruneSnapshots = Effect.fn("pruneSnapshots")(function* (projectId: ProjectId) {
  const config = yield* AppConfig
  const projects = yield* ProjectRepository
  const snapshots = yield* SnapshotRepository
  const knowledge = yield* KnowledgeRepository
  const jobs = yield* JobRepository
  const { currentSnapshot } = yield* projects.get(projectId)
  if (currentSnapshot === null) return
  const versions = yield* snapshots.list(projectId)
  const active = new Set((yield* jobs.active(projectId)).map((job) => job.snapshotId))
  const position = versions.findIndex((version) => version.id === currentSnapshot.id)
  const older = versions.slice(position + 1).filter((version) => !active.has(version.id))
  const complete = (version: Snapshot) =>
    version.status === "ready" &&
    version.analysisStatus === "ready" &&
    (version.understandingStatus === null || version.understandingStatus === "ready")
  const kept = new Set(
    older
      .filter(complete)
      .slice(0, config.snapshotRetention - 1)
      .map((version) => version.id)
  )
  const removed = older.filter((version) => !kept.has(version.id)).map((version) => version.id)
  if (removed.length === 0) return
  // The rag schema has no foreign keys to the application tables: its rows are deleted explicitly.
  yield* knowledge.deleteSnapshots(removed)
  const { uploadIds } = yield* snapshots.delete(removed)
  yield* Effect.forEach(
    uploadIds,
    (id) => Effect.promise(() => fs.rm(uploadPath(config.uploadsDir, id), { force: true })),
    { discard: true }
  )
  yield* Effect.logInfo("Old versions deleted").pipe(Effect.annotateLogs({ projectId, count: removed.length }))
})

/** Makes a version the one in use, then deletes the versions beyond the retention. */
export const promoteSnapshot = Effect.fn("promoteSnapshot")(function* (snapshotId: SnapshotId) {
  const projects = yield* ProjectRepository
  const snapshots = yield* SnapshotRepository
  const { snapshot } = yield* snapshots.get(snapshotId)
  yield* projects.setCurrentSnapshot(snapshot.projectId, snapshotId)
  yield* pruneSnapshots(snapshot.projectId)
})

/**
 * After the static analysis of a version: a new version records its file
 * changes and is updated from its base when the base has cards; otherwise it
 * becomes current. The re-analysis of the current version does nothing more.
 */
export const continueNewVersion = Effect.fn("continueNewVersion")(function* (snapshotId: SnapshotId) {
  const projects = yield* ProjectRepository
  const snapshots = yield* SnapshotRepository
  const { snapshot } = yield* snapshots.get(snapshotId)
  const { currentSnapshot } = yield* projects.get(snapshot.projectId)
  if (currentSnapshot?.id === snapshotId) return
  const base =
    snapshot.baseSnapshotId === null
      ? undefined
      : yield* snapshots.get(snapshot.baseSnapshotId).pipe(
          Effect.map((found) => found.snapshot),
          Effect.catchTag("NotFoundError", () => Effect.succeed(undefined))
        )
  if (base !== undefined) {
    const changes = diffFiles(yield* snapshots.fileHashes(base.id), yield* snapshots.fileHashes(snapshotId))
    yield* snapshots.saveChanges(snapshotId, {
      files: { added: changes.added.length, modified: changes.modified.length, removed: changes.removed.length },
      cards: null
    })
  }
  if (base?.understandingStatus === "ready") {
    yield* requestUpdate(snapshotId, base.id)
  } else {
    yield* promoteSnapshot(snapshotId)
  }
})
