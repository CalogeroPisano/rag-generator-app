import { Effect } from "effect"
import type { Job } from "../domain/model.ts"
import { PhaseError } from "../domain/errors.ts"
import { excludedFile, prepareFile, type PreparedFile } from "../domain/source/prepare.ts"
import type { AnalysisRepository, JobRepository } from "../ports/outbound/repositories.ts"
import { ProjectRepository, SnapshotRepository } from "../ports/outbound/repositories.ts"
import { SecretBox } from "../ports/outbound/secret-box.ts"
import { SourceWorkspace, UploadStore } from "../ports/outbound/source.ts"
import { requestAnalysis } from "./analysis.ts"
import { AppConfig } from "./config.ts"
import type { PhaseContext, Pipeline } from "./pipeline.ts"
import { unchangedBase } from "./updates.ts"

const INSERT_BATCH_SIZE = 200

/** Errors that retrying cannot fix: bad archives, limits, credentials, missing repositories. */
const toPhaseError =
  (phase: string) => (error: { readonly _tag: string; readonly message: string; readonly reason?: string }) => {
    const permanent =
      error._tag === "LimitExceededError" ||
      error._tag === "ArchiveError" ||
      error._tag === "EncryptionError" ||
      error._tag === "NotFoundError" ||
      (error._tag === "GitError" && ["auth", "not_found", "invalid_url"].includes(error.reason ?? ""))
    const message =
      error._tag === "DatabaseError"
        ? "Errore del database"
        : error._tag === "FsError"
          ? "Errore del file system"
          : error.message
    return new PhaseError({ phase, message, retryable: !permanent })
  }

/** fetch: extracts the uploaded zip or clones the repository into a fresh work area. */
const fetchSource = Effect.fn("acquisition.fetch")(
  function* (job: Job) {
    const config = yield* AppConfig
    const snapshots = yield* SnapshotRepository
    const projects = yield* ProjectRepository
    const workspace = yield* SourceWorkspace
    const phase = "fetch"

    yield* snapshots.setStatus(job.snapshotId, "acquiring")
    // Idempotent: whatever a previous attempt left behind is discarded.
    yield* workspace.reset(job.id)

    const { snapshot, uploadId } = yield* snapshots.get(job.snapshotId)
    const { project } = yield* projects.get(snapshot.projectId)

    if (project.sourceType === "zip") {
      if (uploadId === null) {
        return yield* new PhaseError({ phase, message: "La versione non ha un archivio caricato", retryable: false })
      }
      const summary = yield* workspace.extractZip(job.id, uploadId, config.limits)
      if (summary.rejectedUnsafePaths > 0) {
        yield* Effect.logWarning("Archive entries with unsafe paths were rejected").pipe(
          Effect.annotateLogs({ count: summary.rejectedUnsafePaths })
        )
      }
      return
    }

    const source = yield* projects.getGitSource(project.id)
    const secretBox = yield* SecretBox
    const token =
      source.encryptedToken === null ? undefined : yield* secretBox.decrypt(source.encryptedToken, project.id)
    const result = yield* workspace.clone(job.id, {
      url: source.url,
      ref: source.ref,
      username: source.username,
      token,
      allowHttp: config.gitAllowHttp,
      timeout: config.gitCloneTimeout
    })
    yield* snapshots.setCommit(job.snapshotId, result.commit)
  },
  (effect) =>
    effect.pipe(Effect.mapError((error) => (error._tag === "PhaseError" ? error : toPhaseError("fetch")(error))))
)

/** ingest: classifies, masks and stores every file of the work area. */
const ingestFiles = Effect.fn("acquisition.ingest")(
  function* (job: Job, progress: PhaseContext["progress"]) {
    const config = yield* AppConfig
    const snapshots = yield* SnapshotRepository
    const workspace = yield* SourceWorkspace

    // The work area may be gone (e.g. the container restarted): fetch again.
    if (!(yield* workspace.exists(job.id))) yield* fetchSource(job)
    // A new version at the commit of the version in use: nothing to store, finalize discards it.
    if ((yield* unchangedBase(job.snapshotId)) !== undefined) {
      yield* progress({ completed: 0, total: 0, message: "Nessun nuovo commit rispetto alla versione in uso" })
      return
    }

    yield* snapshots.clearFiles(job.snapshotId)
    let batch: Array<PreparedFile> = []
    let stored = 0
    let includedFiles = 0
    let excludedFiles = 0
    let maskedSecrets = 0
    const flush = Effect.gen(function* () {
      if (batch.length === 0) return
      yield* snapshots.insertFiles(job.snapshotId, batch)
      stored += batch.length
      batch = []
      yield* progress({ completed: stored, total: null, message: `${stored} file elaborati` })
    })

    // Every file is classified and masked here, before anything is stored: the original never leaves this loop.
    const { treeHash } = yield* workspace.scan(job.id, config.limits, (entry) =>
      Effect.gen(function* () {
        const file =
          entry.kind === "file"
            ? yield* prepareFile(entry.path, entry.bytes, config.limits)
            : excludedFile(entry.path, entry.reason, entry.size, entry.isDirectory)
        if (file.excluded === undefined) includedFiles++
        else excludedFiles++
        maskedSecrets += file.secrets.length
        batch.push(file)
        if (batch.length >= INSERT_BATCH_SIZE) yield* flush
      })
    )
    yield* flush

    const { snapshot } = yield* snapshots.get(job.snapshotId)
    yield* snapshots.saveScan(job.snapshotId, {
      includedFiles,
      excludedFiles,
      maskedSecrets,
      // Git snapshots are identified by their commit; zips by the hash of their content.
      contentHash: snapshot.commitSha === null ? treeHash : null
    })
  },
  (effect) =>
    effect.pipe(Effect.mapError((error) => (error._tag === "PhaseError" ? error : toPhaseError("ingest")(error))))
)

/**
 * finalize: marks the snapshot ready and removes temporary data. A new version
 * identical to the one in use is discarded (its jobs move to the version in use).
 */
const finalize = Effect.fn("acquisition.finalize")(
  function* (job: Job, progress: PhaseContext["progress"]) {
    const snapshots = yield* SnapshotRepository
    const workspace = yield* SourceWorkspace
    const uploads = yield* UploadStore
    const { uploadId } = yield* snapshots.get(job.snapshotId)
    const unchanged = yield* unchangedBase(job.snapshotId)
    if (unchanged !== undefined) {
      yield* workspace.remove(job.id)
      if (uploadId !== null) yield* uploads.remove(uploadId)
      yield* progress({ completed: 0, total: 0, message: "Nessuna modifica rispetto alla versione in uso" })
      // Last step: once discarded, the job belongs to the version in use.
      return yield* snapshots.discard(job.snapshotId, unchanged.id)
    }
    yield* snapshots.setStatus(job.snapshotId, "ready")
    // The static analysis is a separate job, so it can be re-run on its own.
    yield* requestAnalysis(job.snapshotId)
    yield* workspace.remove(job.id)
    if (uploadId !== null) yield* uploads.remove(uploadId)
  },
  (effect) => effect.pipe(Effect.mapError(toPhaseError("finalize")))
)

export const acquisitionPipeline: Pipeline<
  | AppConfig
  | SnapshotRepository
  | ProjectRepository
  | SecretBox
  | JobRepository
  | AnalysisRepository
  | SourceWorkspace
  | UploadStore
> = {
  type: "acquisition",
  phases: [
    { name: "fetch", run: ({ job }) => fetchSource(job) },
    { name: "ingest", run: ({ job, progress }) => ingestFiles(job, progress) },
    { name: "finalize", run: ({ job, progress }) => finalize(job, progress) }
  ],
  onFailed: (job) =>
    Effect.gen(function* () {
      yield* (yield* SnapshotRepository).setStatus(job.snapshotId, "failed")
      yield* (yield* SourceWorkspace).remove(job.id)
    }).pipe(Effect.ignore)
}
