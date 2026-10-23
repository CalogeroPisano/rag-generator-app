/**
 * Persistence ports. They are implemented in `@code-to-rag/db`; the domain
 * and the pipeline only depend on these interfaces.
 */
import type { CodeSymbol, DependencyTarget, PreparedFile, RawImport, ResolverInput } from "@code-to-rag/analysis"
import { Context, type Effect, type Option } from "effect"
import type {
  AnalysisStatus,
  DependencyOverview,
  FileAnalysisView,
  Job,
  JobEvent,
  JobId,
  JobProgress,
  ProjectId,
  ProjectSummary,
  Snapshot,
  SnapshotId,
  SnapshotStatus,
  SourceFileContent,
  SourceFileEntry,
  SourceType,
  SymbolPage,
  UploadId,
  UserId
} from "./domain.ts"
import type { DatabaseError, NotFoundError } from "./errors.ts"

export interface NewProject {
  readonly id: ProjectId
  readonly name: string
  readonly sourceType: SourceType
  readonly repositoryUrl: string | null
  readonly repositoryRef: string | null
  readonly repositoryUsername: string | null
  /** Token sealed by `SecretBox`, bound to the project id. */
  readonly encryptedToken: string | null
  readonly createdBy: UserId | null
}

export interface GitSourceRecord {
  readonly url: string
  readonly ref: string | null
  readonly username: string | null
  readonly encryptedToken: string | null
}

export class ProjectRepository extends Context.Service<
  ProjectRepository,
  {
    /** Creates project, first snapshot and acquisition job atomically. */
    createWithAcquisition(input: {
      readonly project: NewProject
      readonly snapshotId: SnapshotId
      readonly uploadId: UploadId | null
      readonly jobId: JobId
      readonly maxAttempts: number
    }): Effect.Effect<ProjectSummary, DatabaseError>
    readonly list: Effect.Effect<ReadonlyArray<ProjectSummary>, DatabaseError>
    get(id: ProjectId): Effect.Effect<ProjectSummary, NotFoundError | DatabaseError>
    getGitSource(id: ProjectId): Effect.Effect<GitSourceRecord, NotFoundError | DatabaseError>
  }
>()("code-to-rag/core/ProjectRepository") {}

export interface ScanResult {
  readonly includedFiles: number
  readonly excludedFiles: number
  readonly maskedSecrets: number
  readonly contentHash: string | null
}

export class SnapshotRepository extends Context.Service<
  SnapshotRepository,
  {
    get(
      id: SnapshotId
    ): Effect.Effect<{ readonly snapshot: Snapshot; readonly uploadId: UploadId | null }, NotFoundError | DatabaseError>
    setStatus(id: SnapshotId, status: SnapshotStatus): Effect.Effect<void, DatabaseError>
    setCommit(id: SnapshotId, commitSha: string): Effect.Effect<void, DatabaseError>
    /** Removes every file of the snapshot, so that ingestion can be repeated. */
    clearFiles(id: SnapshotId): Effect.Effect<void, DatabaseError>
    insertFiles(id: SnapshotId, files: ReadonlyArray<PreparedFile>): Effect.Effect<void, DatabaseError>
    saveScan(id: SnapshotId, result: ScanResult): Effect.Effect<void, DatabaseError>
    listFiles(id: SnapshotId): Effect.Effect<ReadonlyArray<SourceFileEntry>, DatabaseError>
    getFileContent(id: SnapshotId, path: string): Effect.Effect<SourceFileContent, NotFoundError | DatabaseError>
    /** Uploads still needed by snapshots that are not acquired yet (or may be retried). */
    readonly pendingUploadIds: Effect.Effect<ReadonlyArray<UploadId>, DatabaseError>
  }
>()("code-to-rag/core/SnapshotRepository") {}

export class JobRepository extends Context.Service<
  JobRepository,
  {
    /**
     * Queues a job for a snapshot unless one of the same type is already queued
     * or running (that one is returned instead).
     */
    enqueue(input: {
      readonly id: JobId
      readonly type: Job["type"]
      readonly projectId: ProjectId
      readonly snapshotId: SnapshotId
      readonly maxAttempts: number
    }): Effect.Effect<Job, DatabaseError>
    /** Atomically takes the oldest runnable job (`FOR UPDATE SKIP LOCKED`). */
    claim(workerId: string): Effect.Effect<Option.Option<Job>, DatabaseError>
    heartbeat(id: JobId, workerId: string): Effect.Effect<void, DatabaseError>
    startPhase(id: JobId, phase: string): Effect.Effect<void, DatabaseError>
    completePhase(id: JobId, phase: string): Effect.Effect<void, DatabaseError>
    reportProgress(id: JobId, progress: JobProgress): Effect.Effect<void, DatabaseError>
    succeed(id: JobId): Effect.Effect<void, DatabaseError>
    fail(id: JobId, message: string): Effect.Effect<void, DatabaseError>
    scheduleRetry(id: JobId, message: string, runAfter: Date): Effect.Effect<void, DatabaseError>
    /** Gives a running job back to the queue (worker shutdown), without consuming an attempt. */
    release(id: JobId): Effect.Effect<void, DatabaseError>
    /** Requeues running jobs whose worker stopped sending heartbeats. */
    requeueStale(heartbeatBefore: Date): Effect.Effect<number, DatabaseError>
    /** Manual retry of a failed job: it resumes from the failed phase. */
    retry(id: JobId): Effect.Effect<Job, NotFoundError | DatabaseError>
    get(id: JobId): Effect.Effect<Job, NotFoundError | DatabaseError>
    eventsAfter(id: JobId, afterEventId: number): Effect.Effect<ReadonlyArray<JobEvent>, DatabaseError>
  }
>()("code-to-rag/core/JobRepository") {}

/** A file to parse, with its masked content. */
export interface FileToAnalyze {
  readonly fileId: number
  readonly path: string
  readonly content: string
}

export interface ParsedFile {
  readonly fileId: number
  readonly packageName: string | null
  readonly parseErrors: number
  readonly symbols: ReadonlyArray<CodeSymbol>
  readonly imports: ReadonlyArray<RawImport>
}

/** An import waiting for resolution. */
export interface PendingDependency {
  readonly id: number
  readonly fromPath: string
  readonly entry: RawImport
}

export interface SymbolQuery {
  readonly search: string | undefined
  readonly kind: CodeSymbol["kind"] | undefined
  readonly exportedOnly: boolean
  readonly limit: number
  readonly offset: number
}

export class AnalysisRepository extends Context.Service<
  AnalysisRepository,
  {
    setStatus(id: SnapshotId, status: AnalysisStatus): Effect.Effect<void, DatabaseError>
    /** Deletes symbols and dependencies of the snapshot, so that analysis can be repeated. */
    clear(id: SnapshotId): Effect.Effect<void, DatabaseError>
    /** Included files in the given languages (see `detectLanguage`), by ascending id, after `afterFileId`. */
    filesToAnalyze(
      id: SnapshotId,
      afterFileId: number,
      limit: number,
      languages: ReadonlyArray<string>
    ): Effect.Effect<ReadonlyArray<FileToAnalyze>, DatabaseError>
    saveParsed(id: SnapshotId, files: ReadonlyArray<ParsedFile>): Effect.Effect<void, DatabaseError>
    resolverInput(id: SnapshotId, isConfigFile: (path: string) => boolean): Effect.Effect<ResolverInput, DatabaseError>
    pendingDependencies(
      id: SnapshotId,
      afterId: number,
      limit: number
    ): Effect.Effect<ReadonlyArray<PendingDependency>, DatabaseError>
    saveTargets(
      id: SnapshotId,
      targets: ReadonlyArray<{ readonly id: number; readonly target: DependencyTarget }>
    ): Effect.Effect<void, DatabaseError>
    /** Stores counts and marks the analysis ready. */
    complete(id: SnapshotId, analyzerVersion: string): Effect.Effect<void, DatabaseError>
    listSymbols(id: SnapshotId, query: SymbolQuery): Effect.Effect<SymbolPage, DatabaseError>
    fileAnalysis(id: SnapshotId, path: string): Effect.Effect<FileAnalysisView, NotFoundError | DatabaseError>
    overview(id: SnapshotId): Effect.Effect<DependencyOverview, DatabaseError>
  }
>()("code-to-rag/core/AnalysisRepository") {}
