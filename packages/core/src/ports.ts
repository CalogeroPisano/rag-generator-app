/**
 * Persistence ports. They are implemented in `@code-to-rag/db`; the domain
 * and the pipeline only depend on these interfaces.
 */
import type { CodeSymbol, DependencyTarget, PreparedFile, RawImport, ResolverInput } from "@code-to-rag/analysis"
import type { CardContent } from "@code-to-rag/ai"
import { Context, type Effect, type Option } from "effect"
import type {
  AnalysisStatus,
  CardStatus,
  CardVerification,
  CardView,
  Correction,
  FeatureMap,
  FeatureSymbol,
  FileSummaryView,
  ModelCallStats,
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
  UnderstandingStatus,
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
    /**
     * Deletes the project and everything of it in the application schema (snapshots, files, jobs…), and the
     * blobs no other file uses. Returns the uploads its snapshots referenced, to delete them from disk.
     */
    delete(id: ProjectId): Effect.Effect<{ readonly uploadIds: ReadonlyArray<UploadId> }, DatabaseError>
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
      readonly payload?: unknown
      /** Jobs of the same type are deduplicated per snapshot and key (e.g. one active job per card). */
      readonly dedupeKey?: string | undefined
    }): Effect.Effect<Job, DatabaseError>
    /** Queued and running jobs of a project. */
    active(projectId: ProjectId): Effect.Effect<ReadonlyArray<Job>, DatabaseError>
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

// ── AI understanding ────────────────────────────────────────────────────────

/** A declaration found by static analysis, as used by the understanding. */
export interface Declaration {
  readonly path: string
  readonly kind: string
  readonly qualifiedName: string
  readonly container: string | null
  readonly exported: boolean
  readonly startLine: number
  readonly endLine: number
}

/** A file read by the understanding: masked content only. */
export interface FileForUnderstanding {
  readonly path: string
  readonly language: string
  readonly contentHash: string
  readonly content: string
}

/** Identity of the analyzed code, copied into the `rag` schema. */
export interface KnowledgeSnapshotInfo {
  readonly snapshotId: SnapshotId
  readonly projectId: ProjectId
  readonly projectName: string
  readonly sourceType: SourceType
  readonly repositoryUrl: string | null
  readonly revision: string
}

/** Application side of the understanding (`public` schema): inputs and status. */
export class UnderstandingRepository extends Context.Service<
  UnderstandingRepository,
  {
    setStatus(id: SnapshotId, status: UnderstandingStatus): Effect.Effect<void, DatabaseError>
    /** Stores the counts and marks the understanding ready. */
    complete(
      id: SnapshotId,
      counts: { readonly features: number; readonly cards: number }
    ): Effect.Effect<void, DatabaseError>
    snapshotInfo(id: SnapshotId): Effect.Effect<KnowledgeSnapshotInfo, NotFoundError | DatabaseError>
    loadFiles(
      id: SnapshotId,
      paths: ReadonlyArray<string>
    ): Effect.Effect<ReadonlyArray<FileForUnderstanding>, DatabaseError>
    declarations(id: SnapshotId): Effect.Effect<ReadonlyArray<Declaration>, DatabaseError>
    modelCallStats(id: SnapshotId): Effect.Effect<ModelCallStats, DatabaseError>
  }
>()("code-to-rag/core/UnderstandingRepository") {}

export interface NewFileSummary {
  readonly path: string
  readonly language: string
  readonly contentHash: string
  readonly summary: string
  readonly parts: number
  readonly symbols: ReadonlyArray<{
    readonly qualifiedName: string
    readonly kind: string
    readonly startLine: number
    readonly endLine: number
    readonly summary: string
  }>
}

export interface StoredSummary {
  readonly path: string
  readonly summary: string
}

export interface NewFeature {
  readonly name: string
  readonly description: string
  readonly files: ReadonlyArray<string>
  readonly symbols: ReadonlyArray<FeatureSymbol>
}

export interface NewCardReference {
  readonly section: string
  readonly itemIndex: number
  readonly claim: string
  readonly path: string
  readonly startLine: number
  readonly endLine: number
}

export interface Reviewer {
  readonly id: string
  readonly name: string
}

export interface NewCorrection {
  readonly projectId: ProjectId
  readonly featureId: string
  readonly featureName: string
  readonly text: string
  readonly author: Reviewer
}

export interface NewVerification {
  readonly cardVersion: number
  readonly statements: CardVerification["statements"]
  readonly missing: CardVerification["missing"]
  readonly issues: number
}

export interface NewCard {
  readonly featureId: string
  readonly status: CardStatus
  readonly content: CardContent
  readonly sourceRevision: string
  readonly unreferencedStatements: number
  readonly references: ReadonlyArray<NewCardReference>
}

/** Who produced an artifact: recorded with summaries, features and cards. */
export interface Provenance {
  readonly model: string
  readonly promptVersion: number
}

/** Knowledge base produced by the understanding (`rag` schema, no links to `public`). */
export class KnowledgeRepository extends Context.Service<
  KnowledgeRepository,
  {
    /** Deletes everything stored for the snapshot and records its identity again. */
    reset(
      info: KnowledgeSnapshotInfo,
      meta: { readonly language: string; readonly model: string }
    ): Effect.Effect<void, DatabaseError>
    fileSummaries(id: SnapshotId): Effect.Effect<ReadonlyArray<StoredSummary>, DatabaseError>
    /** Replaces the summary of one file (and of its symbols). */
    saveFileSummary(id: SnapshotId, summary: NewFileSummary, provenance: Provenance): Effect.Effect<void, DatabaseError>
    moduleSummaries(id: SnapshotId): Effect.Effect<ReadonlyArray<StoredSummary>, DatabaseError>
    saveModuleSummary(
      id: SnapshotId,
      module: { readonly path: string; readonly depth: number; readonly summary: string; readonly fileCount: number },
      provenance: Provenance
    ): Effect.Effect<void, DatabaseError>
    /** Replaces the feature map (and therefore deletes the cards). */
    replaceFeatures(
      id: SnapshotId,
      features: ReadonlyArray<NewFeature>,
      provenance: Provenance
    ): Effect.Effect<void, DatabaseError>
    featureMap(id: SnapshotId): Effect.Effect<FeatureMap, DatabaseError>
    /** Replaces the card of a feature (its verification goes with it); returns the new version number. */
    saveCard(id: SnapshotId, card: NewCard, provenance: Provenance): Effect.Effect<number, DatabaseError>
    getCard(id: SnapshotId, cardId: string): Effect.Effect<CardView, NotFoundError | DatabaseError>
    fileSummary(id: SnapshotId, path: string): Effect.Effect<Option.Option<FileSummaryView>, DatabaseError>
    counts(id: SnapshotId): Effect.Effect<{ readonly features: number; readonly cards: number }, DatabaseError>
    /** Removes the knowledge of a project, corrections included (the application deletes it itself: no foreign keys). */
    deleteProject(projectId: ProjectId): Effect.Effect<void, DatabaseError>

    // ── Review (phase 4) ──
    /** Cards whose current version has no verification yet. */
    cardsToVerify(id: SnapshotId): Effect.Effect<ReadonlyArray<string>, DatabaseError>
    /**
     * Stores the verification of a card version. Cards still `generated` or `flagged` become `flagged` when issues
     * were found, `generated` otherwise; review decisions (in review, approved, excluded) are kept.
     */
    saveVerification(
      id: SnapshotId,
      cardId: string,
      verification: NewVerification,
      provenance: Provenance
    ): Effect.Effect<void, DatabaseError>
    /** Manual edit: new version, status `in_review`. */
    editCard(
      id: SnapshotId,
      cardId: string,
      edit: {
        readonly content: CardContent
        readonly references: ReadonlyArray<NewCardReference>
        readonly unreferencedStatements: number
      },
      reviewer: Reviewer
    ): Effect.Effect<void, NotFoundError | DatabaseError>
    setCardStatus(
      id: SnapshotId,
      cardId: string,
      status: CardStatus,
      reviewer: Reviewer
    ): Effect.Effect<void, NotFoundError | DatabaseError>
    addCorrection(correction: NewCorrection): Effect.Effect<Correction, DatabaseError>
    /** Corrections attached to the features of the snapshot, oldest first. */
    corrections(id: SnapshotId): Effect.Effect<ReadonlyArray<Correction>, DatabaseError>
    markCorrectionsApplied(ids: ReadonlyArray<string>, cardVersion: number): Effect.Effect<void, DatabaseError>
    /** After a new feature map: attaches the project's corrections to the features with the same (normalized) name. */
    reattachCorrections(id: SnapshotId, projectId: ProjectId): Effect.Effect<void, DatabaseError>
  }
>()("code-to-rag/core/KnowledgeRepository") {}
