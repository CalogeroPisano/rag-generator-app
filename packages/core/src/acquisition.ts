import {
  cloneRepository,
  excludedFile,
  ExclusionReason,
  extractZip,
  type PreparedFile,
  scanTree
} from "@code-to-rag/analysis"
import { Effect, Schema } from "effect"
import * as fs from "node:fs/promises"
import * as nodePath from "node:path"
import { requestAnalysis } from "./analysis.ts"
import { AppConfig } from "./config.ts"
import type { Job, UploadId } from "./domain.ts"
import { PhaseError } from "./errors.ts"
import type { PhaseContext, Pipeline } from "./pipeline.ts"
import { type AnalysisRepository, JobRepository, ProjectRepository, SnapshotRepository } from "./ports.ts"
import { SecretBox } from "./secret-box.ts"

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

export const uploadPath = (uploadsDir: string, uploadId: UploadId) => nodePath.join(uploadsDir, `${uploadId}.zip`)

/** Per-job temporary area. Only the worker writes here; it is deleted on success. */
const workspace = (workDir: string, job: Job) => {
  const root = nodePath.join(workDir, job.id)
  return { root, source: nodePath.join(root, "src"), skipped: nodePath.join(root, "skipped.json") }
}

const SkippedEntries = Schema.Array(Schema.Struct({ path: Schema.String, reason: ExclusionReason, size: Schema.Int }))
const SkippedEntriesJson = Schema.fromJsonString(SkippedEntries)

const fsTry = <A>(phase: string, operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: () => new PhaseError({ phase, message: `Errore del file system (${operation})`, retryable: true })
  })

/** fetch: extracts the uploaded zip or clones the repository into a fresh work area. */
const fetchSource = Effect.fn("acquisition.fetch")(
  function* (job: Job) {
    const config = yield* AppConfig
    const snapshots = yield* SnapshotRepository
    const projects = yield* ProjectRepository
    const area = workspace(config.workDir, job)
    const phase = "fetch"

    yield* snapshots.setStatus(job.snapshotId, "acquiring")
    // Idempotent: whatever a previous attempt left behind is discarded.
    yield* fsTry(phase, "workspace reset", async () => {
      await fs.rm(area.root, { recursive: true, force: true })
      await fs.mkdir(area.source, { recursive: true, mode: 0o700 })
    })

    const { snapshot, uploadId } = yield* snapshots.get(job.snapshotId)
    const { project } = yield* projects.get(snapshot.projectId)

    if (project.sourceType === "zip") {
      if (uploadId === null) {
        return yield* new PhaseError({ phase, message: "La versione non ha un archivio caricato", retryable: false })
      }
      const summary = yield* extractZip(uploadPath(config.uploadsDir, uploadId), area.source, config.limits)
      const encoded = yield* Schema.encodeEffect(SkippedEntriesJson)(summary.skipped).pipe(
        Effect.mapError(
          () => new PhaseError({ phase, message: "Impossibile registrare le voci escluse", retryable: false })
        )
      )
      yield* fsTry(phase, "write skipped entries", () => fs.writeFile(area.skipped, encoded))
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
    const result = yield* cloneRepository({
      url: source.url,
      ref: source.ref ?? undefined,
      username: source.username ?? undefined,
      token,
      directory: area.source,
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
    const area = workspace(config.workDir, job)
    const phase = "ingest"

    // The work area may be gone (e.g. the container restarted): fetch again.
    const present = yield* Effect.promise(() =>
      fs.access(area.source).then(
        () => true,
        () => false
      )
    )
    if (!present) yield* fetchSource(job)

    const skippedJson = yield* Effect.promise(() => fs.readFile(area.skipped, "utf8").catch(() => "[]"))
    const skipped = yield* Schema.decodeUnknownEffect(SkippedEntriesJson)(skippedJson).pipe(
      Effect.mapError(
        () => new PhaseError({ phase, message: "Elenco delle voci escluse danneggiato", retryable: true })
      )
    )

    yield* snapshots.clearFiles(job.snapshotId)
    let batch: Array<PreparedFile> = []
    let stored = 0
    const flush = Effect.gen(function* () {
      if (batch.length === 0) return
      yield* snapshots.insertFiles(job.snapshotId, batch)
      stored += batch.length
      batch = []
      yield* progress({ completed: stored, total: null, message: `${stored} file elaborati` })
    })

    const summary = yield* scanTree(
      area.source,
      config.limits,
      skipped.map((entry) => excludedFile(entry.path, entry.reason, entry.size)),
      (file) => {
        batch.push(file)
        return batch.length >= INSERT_BATCH_SIZE ? flush : Effect.void
      }
    )
    yield* flush

    const { snapshot } = yield* snapshots.get(job.snapshotId)
    yield* snapshots.saveScan(job.snapshotId, {
      includedFiles: summary.includedFiles,
      excludedFiles: summary.excludedFiles,
      maskedSecrets: summary.maskedSecrets,
      // Git snapshots are identified by their commit; zips by the hash of their content.
      contentHash: snapshot.commitSha === null ? summary.treeHash : null
    })
  },
  (effect) =>
    effect.pipe(Effect.mapError((error) => (error._tag === "PhaseError" ? error : toPhaseError("ingest")(error))))
)

/** finalize: marks the snapshot ready and removes temporary data. */
const finalize = Effect.fn("acquisition.finalize")(
  function* (job: Job) {
    const config = yield* AppConfig
    const snapshots = yield* SnapshotRepository
    const { uploadId } = yield* snapshots.get(job.snapshotId)
    yield* snapshots.setStatus(job.snapshotId, "ready")
    // The static analysis is a separate job, so it can be re-run on its own.
    yield* requestAnalysis(job.snapshotId)
    yield* Effect.promise(() => fs.rm(workspace(config.workDir, job).root, { recursive: true, force: true }))
    if (uploadId !== null) {
      yield* Effect.promise(() => fs.rm(uploadPath(config.uploadsDir, uploadId), { force: true }))
    }
  },
  (effect) => effect.pipe(Effect.mapError(toPhaseError("finalize")))
)

export const acquisitionPipeline: Pipeline<
  AppConfig | SnapshotRepository | ProjectRepository | SecretBox | JobRepository | AnalysisRepository
> = {
  type: "acquisition",
  phases: [
    { name: "fetch", run: ({ job }) => fetchSource(job) },
    { name: "ingest", run: ({ job, progress }) => ingestFiles(job, progress) },
    { name: "finalize", run: ({ job }) => finalize(job) }
  ],
  onFailed: (job) =>
    Effect.gen(function* () {
      const snapshots = yield* SnapshotRepository
      const config = yield* AppConfig
      yield* snapshots.setStatus(job.snapshotId, "failed")
      yield* Effect.promise(() => fs.rm(workspace(config.workDir, job).root, { recursive: true, force: true }))
    }).pipe(Effect.ignore)
}
