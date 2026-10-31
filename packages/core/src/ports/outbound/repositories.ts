/**
 * Persistence ports. They are implemented in `@code-to-rag/postgres`; the domain
 * and the pipeline only depend on these interfaces.
 */
import type { CodeSymbol, DependencyTarget, RawImport, ResolverInput } from "../../domain/code.ts"
import type { PreparedFile } from "../../domain/source/prepare.ts"
import type { CardContent } from "../../domain/card.ts"
import type { ModelSettingsBody, UserEntry } from "../../domain/settings.ts"
import { Context, type Effect, type Option, type Scope } from "effect"
import type {
  AnalysisStatus,
  CardStatus,
  ChatConversation,
  ChatConversationView,
  ChatMessage,
  ChatMessageStatus,
  ChatSource,
  IndexStatus,
  TestQuestion,
  TestQuestionOrigin,
  TestResult,
  TestRun,
  TestRunStatus,
  TestRunView,
  CardVerification,
  CardView,
  StatementReview,
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
  CardChange,
  Snapshot,
  SnapshotChanges,
  SnapshotId,
  SnapshotStatus,
  SourceFileContent,
  SourceFileEntry,
  SourceType,
  SymbolPage,
  UnderstandingStatus,
  UploadId,
  UserId
} from "../../domain/model.ts"
import type { DatabaseError, NotFoundError } from "../../domain/errors.ts"

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
    /** New version of an existing project: snapshot (based on `baseSnapshotId`) and acquisition job, atomically. */
    createSnapshot(input: {
      readonly projectId: ProjectId
      readonly snapshotId: SnapshotId
      readonly baseSnapshotId: SnapshotId | null
      readonly uploadId: UploadId | null
      readonly jobId: JobId
      readonly maxAttempts: number
    }): Effect.Effect<ProjectSummary, DatabaseError>
    /** Makes a version the one in use. */
    setCurrentSnapshot(id: ProjectId, snapshotId: SnapshotId): Effect.Effect<void, DatabaseError>
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
    /** Hash of the masked content of every included file. */
    fileHashes(
      id: SnapshotId
    ): Effect.Effect<ReadonlyArray<{ readonly path: string; readonly contentHash: string }>, DatabaseError>
    saveChanges(id: SnapshotId, changes: SnapshotChanges): Effect.Effect<void, DatabaseError>
    /** Versions of a project, newest first. */
    list(projectId: ProjectId): Effect.Effect<ReadonlyArray<Snapshot>, DatabaseError>
    /**
     * Deletes versions with their files, analysis and jobs, and the blobs no other file uses. Returns the uploads
     * they referenced, to delete them from disk. The `rag` data is deleted separately.
     */
    delete(
      ids: ReadonlyArray<SnapshotId>
    ): Effect.Effect<{ readonly uploadIds: ReadonlyArray<UploadId> }, DatabaseError>
    /**
     * Drops a new version identical to its base: its jobs move to the base version (so that the running
     * acquisition job can complete), then it is deleted.
     */
    discard(id: SnapshotId, baseId: SnapshotId): Effect.Effect<void, DatabaseError>
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
      /**
       * Which existing job absorbs the request: a queued or running one (default), or only a queued one, for jobs
       * that must see changes made while a previous run is in progress (indexing).
       */
      readonly dedupe?: "active" | "queued" | undefined
    }): Effect.Effect<Job, DatabaseError>
    /** Queued and running jobs of a project. */
    active(projectId: ProjectId): Effect.Effect<ReadonlyArray<Job>, DatabaseError>
    /** Atomically takes the oldest runnable job (`FOR UPDATE SKIP LOCKED`). */
    claim(workerId: string): Effect.Effect<Option.Option<Job>, DatabaseError>
    /**
     * Refreshes the heartbeat of a run. `attempt` is the claim of that run (the attempt count it got): false when the
     * job is no longer that run's (requeued, cancelled, claimed again), and the run must stop.
     */
    heartbeat(id: JobId, workerId: string, attempt: number): Effect.Effect<boolean, DatabaseError>
    startPhase(id: JobId, phase: string): Effect.Effect<void, DatabaseError>
    completePhase(id: JobId, phase: string): Effect.Effect<void, DatabaseError>
    reportProgress(id: JobId, progress: JobProgress): Effect.Effect<void, DatabaseError>
    // With `attempt`, the transition applies only while that run still holds the job (see `heartbeat`).
    succeed(id: JobId, attempt?: number): Effect.Effect<void, DatabaseError>
    fail(id: JobId, message: string, attempt?: number): Effect.Effect<void, DatabaseError>
    scheduleRetry(id: JobId, message: string, runAfter: Date, attempt?: number): Effect.Effect<void, DatabaseError>
    /** Gives a running job back to the queue (worker shutdown), without consuming an attempt. */
    release(id: JobId, attempt?: number): Effect.Effect<void, DatabaseError>
    /** Stops a queued or running job (user action); `cancelled` is false when it had already ended. */
    cancel(id: JobId): Effect.Effect<{ readonly job: Job; readonly cancelled: boolean }, NotFoundError | DatabaseError>
    /**
     * Requeues running jobs whose worker stopped sending heartbeats. Jobs of `exceptWorkerId` (the caller) are
     * skipped: its process is alive, so its jobs are not abandoned.
     */
    requeueStale(heartbeatBefore: Date, exceptWorkerId?: string): Effect.Effect<number, DatabaseError>
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
  /** Incremental update: how the card was produced and the version it continues (of the previous snapshot). */
  readonly change?: CardChange | undefined
  readonly baseVersion?: number | undefined
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
    /** Stores the triage of the features: `technical` ones get no card. */
    classifyFeatures(
      id: SnapshotId,
      triage: ReadonlyArray<{
        readonly featureId: string
        readonly userFacing: number | null
        readonly technical: boolean
      }>
    ): Effect.Effect<void, DatabaseError>
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
    /** Manual edit: new version, status `in_review`, with the given statement decisions. */
    editCard(
      id: SnapshotId,
      cardId: string,
      edit: {
        readonly content: CardContent
        readonly references: ReadonlyArray<NewCardReference>
        readonly unreferencedStatements: number
        /** Reviewer decisions carried to the new version (statements left identical). */
        readonly statementReviews: ReadonlyArray<StatementReview>
      },
      reviewer: Reviewer
    ): Effect.Effect<void, NotFoundError | DatabaseError>
    setCardStatus(
      id: SnapshotId,
      cardId: string,
      status: CardStatus,
      reviewer: Reviewer
    ): Effect.Effect<void, NotFoundError | DatabaseError>
    /**
     * Replaces the reviewer decisions on the statements of the card's current version, and its status when given
     * (with the reviewer, like `setCardStatus`).
     */
    saveStatementReviews(
      id: SnapshotId,
      cardId: string,
      reviews: ReadonlyArray<StatementReview>,
      status: CardStatus | undefined,
      reviewer: Reviewer
    ): Effect.Effect<void, NotFoundError | DatabaseError>
    addCorrection(correction: NewCorrection): Effect.Effect<Correction, DatabaseError>
    /** Corrections attached to the features of the snapshot, oldest first. */
    corrections(id: SnapshotId): Effect.Effect<ReadonlyArray<Correction>, DatabaseError>
    markCorrectionsApplied(ids: ReadonlyArray<string>, cardVersion: number): Effect.Effect<void, DatabaseError>
    /**
     * After a new feature map: attaches the project's corrections to the features with the same (normalized) name.
     * They become pending again, unless `keepApplied` (incremental update: copied cards keep having applied them).
     */
    reattachCorrections(
      id: SnapshotId,
      projectId: ProjectId,
      options?: { readonly keepApplied: boolean }
    ): Effect.Effect<void, DatabaseError>

    // ── Incremental updates (phase 6) ──
    /**
     * Copies the summaries of the given files (and of their declarations) from the base snapshot, when they were
     * written by the same model and prompt version. Returns the paths copied.
     */
    copyFileSummaries(
      id: SnapshotId,
      baseId: SnapshotId,
      paths: ReadonlyArray<string>,
      provenance: Provenance
    ): Effect.Effect<ReadonlyArray<string>, DatabaseError>
    /** Copies module summaries (same model and prompt version) that are not stored yet. */
    copyModuleSummaries(
      id: SnapshotId,
      baseId: SnapshotId,
      paths: ReadonlyArray<string>,
      provenance: Provenance
    ): Effect.Effect<void, DatabaseError>
    /**
     * Copies a card of the base snapshot to a feature of this one: content, status, version, review, verification,
     * references and index chunks. `status` overrides the copied status. Returns the new card id.
     */
    copyCard(
      id: SnapshotId,
      input: { readonly cardId: string; readonly featureId: string; readonly status?: CardStatus | undefined }
    ): Effect.Effect<string, NotFoundError | DatabaseError>
    /** Cards of the snapshot by how the update produced them. */
    changeCounts(
      id: SnapshotId
    ): Effect.Effect<{ readonly kept: number; readonly updated: number; readonly created: number }, DatabaseError>
    /** Deletes the knowledge of the given snapshots (corrections and test questions belong to the project: kept). */
    deleteSnapshots(ids: ReadonlyArray<SnapshotId>): Effect.Effect<void, DatabaseError>
  }
>()("code-to-rag/core/KnowledgeRepository") {}

// ── RAG: index, chat, test questions (phase 5) ──────────────────────────────

/** A card whose chunks are missing or outdated. */
export interface CardToIndex {
  readonly cardId: string
  readonly version: number
  readonly featureName: string
  readonly content: CardContent
}

export interface NewChunk {
  /** `overview` or a card section. */
  readonly section: string
  readonly text: string
  readonly embedding: ReadonlyArray<number>
}

/** A chunk found by one of the searches, best first. */
export interface ChunkHit {
  readonly cardId: string
  readonly section: string
}

export interface ChunkSearch {
  readonly embedding: ReadonlyArray<number>
  readonly model: string
  /** Words of the question for the full-text search (any of them). */
  readonly terms: ReadonlyArray<string>
  /** Candidates per search. */
  readonly limit: number
  readonly approvedOnly: boolean
}

/** A card given to the chat model. */
export interface ContextCard extends ChatSource {
  readonly content: CardContent
}

export interface IndexMeta {
  readonly model: string
  /** Version of the chunk text format (`CARD_CHUNK`). */
  readonly formatVersion: number
}

/** Embedding index of the cards (`rag.chunk`). */
export class IndexRepository extends Context.Service<
  IndexRepository,
  {
    /** Non-excluded cards with no chunks for their current version, model and format. */
    cardsToIndex(id: SnapshotId, meta: IndexMeta): Effect.Effect<ReadonlyArray<CardToIndex>, DatabaseError>
    /** Replaces the chunks of a card; ignored when the card changed version (or disappeared) meanwhile. */
    saveChunks(
      id: SnapshotId,
      card: { readonly cardId: string; readonly version: number },
      chunks: ReadonlyArray<NewChunk>,
      meta: IndexMeta
    ): Effect.Effect<void, DatabaseError>
    /** Deletes every chunk of the snapshot (full rebuild). */
    clear(id: SnapshotId): Effect.Effect<void, DatabaseError>
    status(id: SnapshotId, meta: IndexMeta | undefined): Effect.Effect<IndexStatus, DatabaseError>
    /**
     * Vector and full-text candidates among the chunks of current, non-excluded (or approved) card versions
     * indexed with `model`.
     */
    search(
      id: SnapshotId,
      query: ChunkSearch
    ): Effect.Effect<
      { readonly vector: ReadonlyArray<ChunkHit>; readonly text: ReadonlyArray<ChunkHit> },
      DatabaseError
    >
    /** Cards by id, in the requested order (missing ones are left out). */
    cards(id: SnapshotId, cardIds: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<ContextCard>, DatabaseError>
  }
>()("code-to-rag/core/IndexRepository") {}

export interface NewTestQuestion {
  readonly featureId: string
  readonly featureName: string
  readonly question: string
  readonly expectedAnswer: string | null
  readonly origin: TestQuestionOrigin
  readonly authorName: string | null
  readonly provenance: Provenance | null
}

export interface NewTestRun {
  readonly id: string
  readonly snapshotId: SnapshotId
  readonly model: string
  readonly embeddingModel: string
  readonly topK: number
  readonly approvedOnly: boolean
  readonly questions: number
}

export interface TestRunTotals {
  readonly retrievalHits: number
  readonly firstHits: number
  readonly mrr: number
  readonly correct: number
  readonly partial: number
  readonly incorrect: number
  readonly noAnswer: number
  readonly unjudged: number
}

/** Test questions and runs (`rag` schema). */
export class EvaluationRepository extends Context.Service<
  EvaluationRepository,
  {
    /** Questions of the project, attached to the features of the snapshot or orphans, oldest first. */
    questions(id: SnapshotId, projectId: ProjectId): Effect.Effect<ReadonlyArray<TestQuestion>, DatabaseError>
    addQuestions(projectId: ProjectId, questions: ReadonlyArray<NewTestQuestion>): Effect.Effect<void, DatabaseError>
    updateQuestion(
      projectId: ProjectId,
      questionId: string,
      update: {
        readonly featureId: string
        readonly featureName: string
        readonly question: string
        readonly expectedAnswer: string | null
      }
    ): Effect.Effect<void, NotFoundError | DatabaseError>
    deleteQuestion(projectId: ProjectId, questionId: string): Effect.Effect<void, NotFoundError | DatabaseError>
    /** After a new feature map: attaches the project's questions to the features with the same name. */
    reattachQuestions(id: SnapshotId, projectId: ProjectId): Effect.Effect<void, DatabaseError>
    /** Creates the run, or resets it (results deleted) when the job runs again. */
    startRun(run: NewTestRun): Effect.Effect<void, DatabaseError>
    getRun(runId: string): Effect.Effect<TestRunView, NotFoundError | DatabaseError>
    saveResult(runId: string, result: TestResult): Effect.Effect<void, DatabaseError>
    finishRun(runId: string, status: TestRunStatus, totals: TestRunTotals | null): Effect.Effect<void, DatabaseError>
    /** Runs of every kept version of the snapshot's project, newest first (to compare versions). */
    runs(id: SnapshotId): Effect.Effect<ReadonlyArray<TestRun>, DatabaseError>
  }
>()("code-to-rag/core/EvaluationRepository") {}

export interface NewChatMessage {
  readonly role: "user" | "assistant"
  readonly content: string
  readonly status: ChatMessageStatus
  readonly sources: ReadonlyArray<ChatSource>
  readonly citations: ReadonlyArray<number>
  readonly snapshotId: SnapshotId | null
  readonly model: string | null
}

/** Chat conversations (application schema): private to the user who started them. */
export class ChatRepository extends Context.Service<
  ChatRepository,
  {
    conversations(projectId: ProjectId, userId: UserId): Effect.Effect<ReadonlyArray<ChatConversation>, DatabaseError>
    createConversation(input: {
      readonly projectId: ProjectId
      readonly userId: UserId
      readonly title: string
    }): Effect.Effect<ChatConversation, DatabaseError>
    getConversation(
      conversationId: string,
      userId: UserId
    ): Effect.Effect<ChatConversationView, NotFoundError | DatabaseError>
    addMessage(conversationId: string, message: NewChatMessage): Effect.Effect<ChatMessage, DatabaseError>
    deleteConversation(conversationId: string, userId: UserId): Effect.Effect<void, NotFoundError | DatabaseError>
  }
>()("code-to-rag/core/ChatRepository") {}

/** Tables of the `rag` schema, in dependency order (referenced tables first). */
export const EXPORT_TABLES = [
  "snapshot",
  "file_summary",
  "symbol_summary",
  "module_summary",
  "feature",
  "card",
  "card_reference",
  "card_verification",
  "correction",
  "chunk",
  "test_question",
  "test_run",
  "test_result"
] as const
export type ExportTable = (typeof EXPORT_TABLES)[number]

/** What an export covers: the current version of a project, every card except excluded ones or approved ones only. */
export interface ExportScope {
  readonly projectId: ProjectId
  readonly snapshotId: SnapshotId
  readonly approvedOnly: boolean
}

/** An exported column with its Postgres type (`format_type`: `text`, `jsonb`, `text[]`, `vector`…). */
export interface ExportColumn {
  readonly name: string
  readonly type: string
}

export interface ExportEmbedding {
  readonly model: string
  readonly dimensions: number
  readonly formatVersion: number
  readonly chunks: number
}

/**
 * Reads the rows in scope of every `rag` table inside one read-only transaction, so that the files of an export
 * are consistent with each other. Rows are plain JSON objects keyed by column name (vectors as arrays of numbers,
 * timestamps as ISO strings in UTC); serial ids and generated columns are left out.
 */
export interface ExportReader {
  /** `CREATE … IF NOT EXISTS` statements recreating the `rag` schema as it is in this database. */
  readonly schemaStatements: Effect.Effect<ReadonlyArray<string>, DatabaseError>
  columns(table: ExportTable): Effect.Effect<ReadonlyArray<ExportColumn>, DatabaseError>
  count(table: ExportTable): Effect.Effect<number, DatabaseError>
  /** Rows after the `after` cursor (null: from the start), in a stable order. `next` is null after the last page. */
  page(
    table: ExportTable,
    after: string | number | null,
    limit: number
  ): Effect.Effect<
    { readonly rows: ReadonlyArray<Record<string, unknown>>; readonly next: string | number | null },
    DatabaseError
  >
  readonly embeddings: Effect.Effect<ReadonlyArray<ExportEmbedding>, DatabaseError>
}

/** Knowledge export (phase 7). */
export class ExportRepository extends Context.Service<
  ExportRepository,
  {
    /** Opens the transaction of an export; it ends with the scope. */
    open(scope: ExportScope): Effect.Effect<ExportReader, DatabaseError, Scope.Scope>
  }
>()("code-to-rag/core/ExportRepository") {}

// ── Settings and administrators ─────────────────────────────────────────────

export interface StoredModelSettings {
  readonly body: ModelSettingsBody
  /** API keys sealed with `SecretBox` (context `model-connection:<id>`), by connection id. */
  readonly sealedKeys: Readonly<Record<string, string>>
  readonly updatedAt: Date
  readonly updatedBy: string
}

export class SettingsRepository extends Context.Service<
  SettingsRepository,
  {
    /** The saved model settings; none until an administrator saves them (the environment applies). */
    loadModelSettings(): Effect.Effect<Option.Option<StoredModelSettings>, DatabaseError>
    /** Time of the last save: a cheap check for changes made by another process. */
    modelSettingsVersion(): Effect.Effect<Option.Option<Date>, DatabaseError>
    saveModelSettings(settings: StoredModelSettings): Effect.Effect<void, DatabaseError>
  }
>()("code-to-rag/core/SettingsRepository") {}

export class UserRepository extends Context.Service<
  UserRepository,
  {
    /** Every account, oldest first, with its administrator flag. */
    list(): Effect.Effect<ReadonlyArray<UserEntry>, DatabaseError>
    /** Administrators are the granted accounts; while none is granted, the oldest account is. */
    isAdmin(userId: string): Effect.Effect<boolean, DatabaseError>
    setAdmin(userId: string, admin: boolean, grantedBy: string): Effect.Effect<void, NotFoundError | DatabaseError>
  }
>()("code-to-rag/core/UserRepository") {}
