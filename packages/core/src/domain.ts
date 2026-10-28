import { AnswerVerdict, CardContent, CardReference, CardSectionName, StatementVerdict } from "@code-to-rag/ai"
import { ExclusionReason, ImportKind, SymbolKind } from "@code-to-rag/analysis"
import { Schema } from "effect"

// ── Identifiers ─────────────────────────────────────────────────────────────

const Uuid = Schema.String.check(Schema.isUUID())

export const ProjectId = Uuid.pipe(Schema.brand("ProjectId"))
export type ProjectId = typeof ProjectId.Type
export const SnapshotId = Uuid.pipe(Schema.brand("SnapshotId"))
export type SnapshotId = typeof SnapshotId.Type
export const JobId = Uuid.pipe(Schema.brand("JobId"))
export type JobId = typeof JobId.Type
export const UploadId = Uuid.pipe(Schema.brand("UploadId"))
export type UploadId = typeof UploadId.Type
export const UserId = Schema.NonEmptyString.pipe(Schema.brand("UserId"))
export type UserId = typeof UserId.Type

// ── Projects and snapshots ──────────────────────────────────────────────────

export const SourceType = Schema.Literals(["zip", "git"])
export type SourceType = typeof SourceType.Type

export const SnapshotStatus = Schema.Literals(["pending", "acquiring", "ready", "failed"])
export type SnapshotStatus = typeof SnapshotStatus.Type

export const AnalysisStatus = Schema.Literals(["pending", "running", "ready", "failed"])
export type AnalysisStatus = typeof AnalysisStatus.Type

export const UnderstandingStatus = Schema.Literals(["pending", "running", "ready", "failed"])
export type UnderstandingStatus = typeof UnderstandingStatus.Type

export class Project extends Schema.Class<Project>("Project")({
  id: ProjectId,
  name: Schema.String,
  sourceType: SourceType,
  repositoryUrl: Schema.NullOr(Schema.String),
  repositoryRef: Schema.NullOr(Schema.String),
  hasCredentials: Schema.Boolean,
  createdBy: Schema.NullOr(UserId),
  createdAt: Schema.Date
}) {}

export class Snapshot extends Schema.Class<Snapshot>("Snapshot")({
  id: SnapshotId,
  projectId: ProjectId,
  status: SnapshotStatus,
  /** Commit SHA for Git sources. */
  commitSha: Schema.NullOr(Schema.String),
  /** Hash of the original tree for zip sources (see `ScanSummary.treeHash`). */
  contentHash: Schema.NullOr(Schema.String),
  includedFiles: Schema.Int,
  excludedFiles: Schema.Int,
  maskedSecrets: Schema.Int,
  /** Static analysis; null until an analysis job has been queued. */
  analysisStatus: Schema.NullOr(AnalysisStatus),
  analyzedAt: Schema.NullOr(Schema.Date),
  symbolCount: Schema.Int,
  dependencyCount: Schema.Int,
  /** AI understanding; null until an understanding job has been queued. */
  understandingStatus: Schema.NullOr(UnderstandingStatus),
  understoodAt: Schema.NullOr(Schema.Date),
  featureCount: Schema.Int,
  cardCount: Schema.Int,
  createdAt: Schema.Date
}) {}

// ── Source files ────────────────────────────────────────────────────────────

export const SecretFinding = Schema.Struct({ rule: Schema.String, line: Schema.Int })

/** File metadata without content, used for the file tree. */
export class SourceFileEntry extends Schema.Class<SourceFileEntry>("SourceFileEntry")({
  path: Schema.String,
  language: Schema.String,
  size: Schema.Int,
  isDirectory: Schema.Boolean,
  excludedReason: Schema.NullOr(ExclusionReason),
  lineCount: Schema.Int,
  secretCount: Schema.Int,
  /** Syntax errors found by static analysis; null when the file was not analyzed. */
  parseErrors: Schema.NullOr(Schema.Int)
}) {}

export class SourceFileContent extends Schema.Class<SourceFileContent>("SourceFileContent")({
  path: Schema.String,
  language: Schema.String,
  content: Schema.String,
  secrets: Schema.Array(SecretFinding)
}) {}

// ── Static analysis ─────────────────────────────────────────────────────────

export const DependencyTargetKind = Schema.Literals([
  "pending",
  "file",
  "directory",
  "namespace",
  "external",
  "unresolved"
])
export type DependencyTargetKind = typeof DependencyTargetKind.Type

export class SymbolEntry extends Schema.Class<SymbolEntry>("SymbolEntry")({
  path: Schema.String,
  kind: SymbolKind,
  name: Schema.String,
  qualifiedName: Schema.String,
  container: Schema.NullOr(Schema.String),
  startLine: Schema.Int,
  endLine: Schema.Int,
  exported: Schema.Boolean,
  signature: Schema.String,
  doc: Schema.NullOr(Schema.String)
}) {}

export class SymbolPage extends Schema.Class<SymbolPage>("SymbolPage")({
  items: Schema.Array(SymbolEntry),
  total: Schema.Int
}) {}

/** An import of a file, with its resolved target. */
export class DependencyEntry extends Schema.Class<DependencyEntry>("DependencyEntry")({
  specifier: Schema.String,
  kind: ImportKind,
  line: Schema.Int,
  names: Schema.Array(Schema.String),
  targetKind: DependencyTargetKind,
  /** File path, directory path or namespace, depending on the target kind. */
  target: Schema.NullOr(Schema.String),
  externalName: Schema.NullOr(Schema.String)
}) {}

/** A file importing the selected one. */
export class DependentEntry extends Schema.Class<DependentEntry>("DependentEntry")({
  path: Schema.String,
  line: Schema.Int,
  specifier: Schema.String
}) {}

export class FileAnalysisView extends Schema.Class<FileAnalysisView>("FileAnalysisView")({
  path: Schema.String,
  symbols: Schema.Array(SymbolEntry),
  imports: Schema.Array(DependencyEntry),
  importedBy: Schema.Array(DependentEntry)
}) {}

export class DependencyOverview extends Schema.Class<DependencyOverview>("DependencyOverview")({
  /** External packages by number of importing files. */
  externals: Schema.Array(Schema.Struct({ name: Schema.String, files: Schema.Int })),
  /** Internal files most imported by others. */
  hubs: Schema.Array(Schema.Struct({ path: Schema.String, importedBy: Schema.Int, imports: Schema.Int })),
  /** Count of dependencies per target kind. */
  byTargetKind: Schema.Array(Schema.Struct({ targetKind: DependencyTargetKind, count: Schema.Int })),
  /** Analyzed files per language. */
  languages: Schema.Array(Schema.Struct({ language: Schema.String, files: Schema.Int, symbols: Schema.Int }))
}) {}

// ── AI understanding (stored in the `rag` schema) ──────────────────────────

export const CardStatus = Schema.Literals([
  "generated",
  "flagged",
  "in_review",
  "approved",
  "excluded",
  "needs_recheck"
])
export type CardStatus = typeof CardStatus.Type

export const FeatureSymbol = Schema.Struct({ path: Schema.String, qualifiedName: Schema.String })
export type FeatureSymbol = typeof FeatureSymbol.Type

export class CardInfo extends Schema.Class<CardInfo>("CardInfo")({
  id: Schema.String,
  status: CardStatus,
  title: Schema.String,
  unreferencedStatements: Schema.Int,
  /** Issues found by the verification of the current version; null when not verified (or outdated). */
  issues: Schema.NullOr(Schema.Int)
}) {}

export class FeatureEntry extends Schema.Class<FeatureEntry>("FeatureEntry")({
  id: Schema.String,
  position: Schema.Int,
  name: Schema.String,
  description: Schema.String,
  files: Schema.Array(Schema.String),
  symbols: Schema.Array(FeatureSymbol),
  card: Schema.NullOr(CardInfo)
}) {}

/** A reviewer's description of a mistake; kept across regenerations (re-attached by feature name). */
export class Correction extends Schema.Class<Correction>("Correction")({
  id: Schema.String,
  featureName: Schema.String,
  /** Null when no feature of the current map has the same name (orphan). */
  featureId: Schema.NullOr(Schema.String),
  text: Schema.String,
  authorName: Schema.String,
  createdAt: Schema.Date,
  /** Card version that applied it last; null while pending. */
  appliedVersion: Schema.NullOr(Schema.Int)
}) {}

export class FeatureMap extends Schema.Class<FeatureMap>("FeatureMap")({
  /** Summary of the project root module. */
  projectSummary: Schema.NullOr(Schema.String),
  features: Schema.Array(FeatureEntry),
  /** Corrections whose feature no longer exists in the map. */
  orphanCorrections: Schema.Array(Correction)
}) {}

export const CardOperation = Schema.Literals(["verify", "regenerate", "correct"])
export type CardOperation = typeof CardOperation.Type

/** Result of the automatic verification of one card version. */
export class CardVerification extends Schema.Class<CardVerification>("CardVerification")({
  cardVersion: Schema.Int,
  verifiedAt: Schema.Date,
  model: Schema.String,
  statements: Schema.Array(Schema.Struct({ id: Schema.String, verdict: StatementVerdict, note: Schema.String })),
  missing: Schema.Array(
    Schema.Struct({ section: CardSectionName, text: Schema.String, references: Schema.Array(CardReference) })
  ),
  /** Statements not fully supported + missing items + statements without references. */
  issues: Schema.Int
}) {}

export class CardView extends Schema.Class<CardView>("CardView")({
  id: Schema.String,
  feature: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    description: Schema.String,
    files: Schema.Array(Schema.String),
    symbols: Schema.Array(FeatureSymbol)
  }),
  status: CardStatus,
  content: CardContent,
  sourceRevision: Schema.String,
  version: Schema.Int,
  unreferencedStatements: Schema.Int,
  model: Schema.String,
  createdAt: Schema.Date,
  updatedAt: Schema.Date,
  /** Last manual edit or review decision. */
  reviewedBy: Schema.NullOr(Schema.String),
  reviewedAt: Schema.NullOr(Schema.Date),
  verification: Schema.NullOr(CardVerification),
  corrections: Schema.Array(Correction)
}) {}

export class SymbolSummaryEntry extends Schema.Class<SymbolSummaryEntry>("SymbolSummaryEntry")({
  qualifiedName: Schema.String,
  kind: Schema.String,
  startLine: Schema.Int,
  endLine: Schema.Int,
  summary: Schema.String
}) {}

export class FileSummaryView extends Schema.Class<FileSummaryView>("FileSummaryView")({
  path: Schema.String,
  summary: Schema.String,
  model: Schema.String,
  symbols: Schema.Array(SymbolSummaryEntry)
}) {}

export const ModelCallTotals = Schema.Struct({
  calls: Schema.Int,
  failures: Schema.Int,
  inputTokens: Schema.Int,
  outputTokens: Schema.Int,
  durationMs: Schema.Int
})
export type ModelCallTotals = typeof ModelCallTotals.Type

export class ModelCallStats extends Schema.Class<ModelCallStats>("ModelCallStats")({
  total: ModelCallTotals,
  byTask: Schema.Array(Schema.Struct({ task: Schema.String, ...ModelCallTotals.fields })),
  models: Schema.Array(Schema.String)
}) {}

/** Input of a `card` job: one operation on one card. */
export const CardJobPayload = Schema.Struct({
  cardId: Schema.String,
  featureId: Schema.String,
  operation: CardOperation
})
export type CardJobPayload = typeof CardJobPayload.Type

// ── RAG: index, chat, test questions (phase 5) ─────────────────────────────

/** Embedding index of a snapshot's cards. */
export class IndexStatus extends Schema.Class<IndexStatus>("IndexStatus")({
  /** Configured embedding model; null when embeddings are not configured. */
  model: Schema.NullOr(Schema.String),
  /** Cards that belong in the index (all but the excluded ones). */
  indexableCards: Schema.Int,
  /** Of those, cards whose current version is indexed with the configured model. */
  indexedCards: Schema.Int,
  approvedCards: Schema.Int,
  chunks: Schema.Int,
  indexedAt: Schema.NullOr(Schema.Date)
}) {}

/** A card given to the chat model as a numbered source. */
export const ChatSource = Schema.Struct({
  cardId: Schema.String,
  featureId: Schema.String,
  featureName: Schema.String,
  title: Schema.String,
  status: CardStatus
})
export type ChatSource = typeof ChatSource.Type

export const ChatMessageStatus = Schema.Literals(["complete", "failed", "interrupted"])
export type ChatMessageStatus = typeof ChatMessageStatus.Type

export class ChatMessage extends Schema.Class<ChatMessage>("ChatMessage")({
  id: Schema.String,
  role: Schema.Literals(["user", "assistant"]),
  content: Schema.String,
  status: ChatMessageStatus,
  /** Sources given to the model, numbered from 1 in this order (assistant messages). */
  sources: Schema.Array(ChatSource),
  /** Source numbers cited by the answer. */
  citations: Schema.Array(Schema.Int),
  snapshotId: Schema.NullOr(SnapshotId),
  model: Schema.NullOr(Schema.String),
  createdAt: Schema.Date
}) {}

export class ChatConversation extends Schema.Class<ChatConversation>("ChatConversation")({
  id: Schema.String,
  projectId: ProjectId,
  title: Schema.String,
  createdAt: Schema.Date,
  updatedAt: Schema.Date
}) {}

export class ChatConversationView extends Schema.Class<ChatConversationView>("ChatConversationView")({
  conversation: ChatConversation,
  messages: Schema.Array(ChatMessage)
}) {}

export const TestQuestionOrigin = Schema.Literals(["generated", "manual"])
export type TestQuestionOrigin = typeof TestQuestionOrigin.Type

/** A test question of the chat; like corrections, it belongs to the project and to a feature name. */
export class TestQuestion extends Schema.Class<TestQuestion>("TestQuestion")({
  id: Schema.String,
  /** Feature of the current map with the same name; null when it disappeared (orphan). */
  featureId: Schema.NullOr(Schema.String),
  featureName: Schema.String,
  question: Schema.String,
  expectedAnswer: Schema.NullOr(Schema.String),
  origin: TestQuestionOrigin,
  authorName: Schema.NullOr(Schema.String),
  createdAt: Schema.Date
}) {}

export const TestRunStatus = Schema.Literals(["running", "ready", "failed"])
export type TestRunStatus = typeof TestRunStatus.Type

export class TestRun extends Schema.Class<TestRun>("TestRun")({
  /** Same id as the evaluation job. */
  id: Schema.String,
  snapshotId: SnapshotId,
  status: TestRunStatus,
  model: Schema.String,
  embeddingModel: Schema.String,
  /** Cards given to the chat model per question. */
  topK: Schema.Int,
  approvedOnly: Schema.Boolean,
  questions: Schema.Int,
  /** Questions whose expected card was among the retrieved ones / ranked first. */
  retrievalHits: Schema.Int,
  firstHits: Schema.Int,
  /** Mean reciprocal rank of the expected card (0 when not retrieved). */
  mrr: Schema.Number,
  correct: Schema.Int,
  partial: Schema.Int,
  incorrect: Schema.Int,
  noAnswer: Schema.Int,
  /** Answers the judge could not assess. */
  unjudged: Schema.Int,
  startedAt: Schema.Date,
  finishedAt: Schema.NullOr(Schema.Date)
}) {}

export class TestResult extends Schema.Class<TestResult>("TestResult")({
  questionId: Schema.String,
  question: Schema.String,
  expectedFeatureId: Schema.String,
  expectedFeatureName: Schema.String,
  /** Retrieved cards, best first. */
  retrieved: Schema.Array(Schema.Struct({ featureId: Schema.String, featureName: Schema.String })),
  /** 1-based position of the expected card among the retrieved ones; null when missing. */
  rank: Schema.NullOr(Schema.Int),
  answer: Schema.String,
  citedFeatureIds: Schema.Array(Schema.String),
  verdict: Schema.NullOr(AnswerVerdict),
  note: Schema.NullOr(Schema.String)
}) {}

export class TestRunView extends Schema.Class<TestRunView>("TestRunView")({
  run: TestRun,
  results: Schema.Array(TestResult)
}) {}

/** Input of an `evaluation` job. */
export const EvaluationJobPayload = Schema.Struct({ approvedOnly: Schema.Boolean })
export type EvaluationJobPayload = typeof EvaluationJobPayload.Type

// ── Jobs ────────────────────────────────────────────────────────────────────

export const JobType = Schema.Literals([
  "acquisition",
  "analysis",
  "understanding",
  "card",
  "indexing",
  "questions",
  "evaluation"
])
export type JobType = typeof JobType.Type

export const JobStatus = Schema.Literals(["queued", "running", "succeeded", "failed", "cancelled"])
export type JobStatus = typeof JobStatus.Type

export const JobProgress = Schema.Struct({
  phase: Schema.String,
  completed: Schema.Int,
  total: Schema.NullOr(Schema.Int),
  message: Schema.NullOr(Schema.String)
})
export type JobProgress = typeof JobProgress.Type

export class Job extends Schema.Class<Job>("Job")({
  id: JobId,
  type: JobType,
  projectId: ProjectId,
  snapshotId: SnapshotId,
  status: JobStatus,
  currentPhase: Schema.NullOr(Schema.String),
  completedPhases: Schema.Array(Schema.String),
  attempts: Schema.Int,
  maxAttempts: Schema.Int,
  lastError: Schema.NullOr(Schema.String),
  progress: Schema.NullOr(JobProgress),
  /** Job-specific input: card and evaluation jobs have one. */
  payload: Schema.NullOr(Schema.Union([CardJobPayload, EvaluationJobPayload])),
  createdAt: Schema.Date,
  updatedAt: Schema.Date,
  finishedAt: Schema.NullOr(Schema.Date)
}) {}

export class ProjectSummary extends Schema.Class<ProjectSummary>("ProjectSummary")({
  project: Project,
  latestSnapshot: Schema.NullOr(Snapshot),
  latestJob: Schema.NullOr(Job)
}) {}

export const JobEventKind = Schema.Literals([
  "queued",
  "started",
  "phase_started",
  "progress",
  "phase_completed",
  "retry_scheduled",
  "succeeded",
  "failed",
  "cancelled"
])
export type JobEventKind = typeof JobEventKind.Type

export class JobEvent extends Schema.Class<JobEvent>("JobEvent")({
  /** Monotonic id, used as the SSE `id` so clients can resume. */
  id: Schema.Int,
  jobId: JobId,
  kind: JobEventKind,
  phase: Schema.NullOr(Schema.String),
  message: Schema.NullOr(Schema.String),
  progress: Schema.NullOr(JobProgress),
  createdAt: Schema.Date
}) {}

export const isTerminalStatus = (status: JobStatus): boolean =>
  status === "succeeded" || status === "failed" || status === "cancelled"

// ── Inputs ──────────────────────────────────────────────────────────────────

const ProjectName = Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(120))

export const ZipSource = Schema.Struct({
  type: Schema.Literal("zip"),
  uploadId: UploadId
})

export const GitSource = Schema.Struct({
  type: Schema.Literal("git"),
  url: Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(2048)),
  ref: Schema.optional(Schema.Trimmed.check(Schema.isMaxLength(255))),
  username: Schema.optional(Schema.Trimmed.check(Schema.isMaxLength(255))),
  /** Plain token as typed by the user; encrypted before it is stored. */
  token: Schema.optional(Schema.String.check(Schema.isMaxLength(4096)))
})

export const CreateProjectInput = Schema.Struct({
  name: ProjectName,
  source: Schema.Union([ZipSource, GitSource])
})
export type CreateProjectInput = typeof CreateProjectInput.Type

const QuestionText = Schema.Trimmed.check(Schema.isMinLength(3), Schema.isMaxLength(2000))

/** A test question written by a reviewer. */
export const TestQuestionInput = Schema.Struct({
  featureId: Schema.String.check(Schema.isUUID()),
  question: QuestionText,
  expectedAnswer: Schema.NullOr(Schema.Trimmed.check(Schema.isMaxLength(4000)))
})
export type TestQuestionInput = typeof TestQuestionInput.Type

/** Manual edit of a card by a reviewer. */
export const EditCardInput = Schema.Struct({ cardId: Schema.String, content: CardContent })
export type EditCardInput = typeof EditCardInput.Type
