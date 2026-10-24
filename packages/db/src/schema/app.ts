import { sql } from "drizzle-orm"
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core"
import { user } from "./auth.ts"

const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date())

export const project = pgTable(
  "project",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    sourceType: text("source_type").notNull(),
    repositoryUrl: text("repository_url"),
    repositoryRef: text("repository_ref"),
    repositoryUsername: text("repository_username"),
    /** AES-256-GCM sealed token (see SecretBox); never plain text. */
    encryptedToken: text("encrypted_token"),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt()
  },
  (table) => [check("project_source_type_check", sql`${table.sourceType} in ('zip', 'git')`)]
)

export const snapshot = pgTable(
  "snapshot",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    commitSha: text("commit_sha"),
    contentHash: text("content_hash"),
    uploadId: uuid("upload_id"),
    includedFiles: integer("included_files").notNull().default(0),
    excludedFiles: integer("excluded_files").notNull().default(0),
    maskedSecrets: integer("masked_secrets").notNull().default(0),
    /** Static analysis: null until an analysis job has been queued. */
    analysisStatus: text("analysis_status"),
    analyzerVersion: text("analyzer_version"),
    analyzedAt: timestamp("analyzed_at", { withTimezone: true }),
    symbolCount: integer("symbol_count").notNull().default(0),
    dependencyCount: integer("dependency_count").notNull().default(0),
    /** AI understanding: null until a job has been queued. Its output lives in the `rag` schema. */
    understandingStatus: text("understanding_status"),
    understoodAt: timestamp("understood_at", { withTimezone: true }),
    featureCount: integer("feature_count").notNull().default(0),
    cardCount: integer("card_count").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    index("snapshot_project_idx").on(table.projectId, table.createdAt),
    check("snapshot_status_check", sql`${table.status} in ('pending', 'acquiring', 'ready', 'failed')`),
    check(
      "snapshot_analysis_status_check",
      sql`${table.analysisStatus} is null or ${table.analysisStatus} in ('pending', 'running', 'ready', 'failed')`
    ),
    check(
      "snapshot_understanding_status_check",
      sql`${table.understandingStatus} is null or ${table.understandingStatus} in ('pending', 'running', 'ready', 'failed')`
    )
  ]
)

/** Masked file contents, deduplicated by hash across snapshots. */
export const sourceBlob = pgTable("source_blob", {
  hash: text("hash").primaryKey(),
  content: text("content").notNull(),
  createdAt: createdAt()
})

export const sourceFile = pgTable(
  "source_file",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => snapshot.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    language: text("language").notNull(),
    size: integer("size").notNull(),
    isDirectory: boolean("is_directory").notNull().default(false),
    /** Null when the file is included in the analysis. */
    excludedReason: text("excluded_reason"),
    contentHash: text("content_hash").references(() => sourceBlob.hash),
    lineCount: integer("line_count").notNull().default(0),
    encoding: text("encoding"),
    /** Masked secrets: `[{ rule, line }]`, never the secret itself. */
    secrets: jsonb("secrets").$type<Array<{ rule: string; line: number }>>().notNull().default([]),
    /** Java/Go package declared by the file (static analysis). */
    packageName: text("package_name"),
    /** Syntax errors found by the parser; null when the file was not analyzed. */
    parseErrors: integer("parse_errors"),
    createdAt: createdAt()
  },
  (table) => [uniqueIndex("source_file_snapshot_path_idx").on(table.snapshotId, table.path)]
)

/** Declarations found by static analysis. Lines refer to the masked content (same as the original). */
export const symbol = pgTable(
  "symbol",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => snapshot.id, { onDelete: "cascade" }),
    fileId: bigint("file_id", { mode: "number" })
      .notNull()
      .references(() => sourceFile.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    qualifiedName: text("qualified_name").notNull(),
    /** Qualified name of the enclosing declaration; null at top level. */
    container: text("container"),
    startLine: integer("start_line").notNull(),
    endLine: integer("end_line").notNull(),
    exported: boolean("exported").notNull(),
    signature: text("signature").notNull(),
    doc: text("doc")
  },
  (table) => [
    index("symbol_file_idx").on(table.fileId, table.startLine),
    index("symbol_snapshot_name_idx").on(table.snapshotId, table.name)
  ]
)

/**
 * Imports between files. The target keeps the granularity native to the
 * language: `file`, `directory` (Go package, Java `pkg.*`), `namespace` (C#),
 * `external` (library) or `unresolved`; `pending` until the resolve phase.
 */
export const fileDependency = pgTable(
  "file_dependency",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => snapshot.id, { onDelete: "cascade" }),
    fileId: bigint("file_id", { mode: "number" })
      .notNull()
      .references(() => sourceFile.id, { onDelete: "cascade" }),
    specifier: text("specifier").notNull(),
    kind: text("kind").notNull(),
    line: integer("line").notNull(),
    names: text("names")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    targetKind: text("target_kind").notNull(),
    targetFileId: bigint("target_file_id", { mode: "number" }).references(() => sourceFile.id, {
      onDelete: "set null"
    }),
    /** Directory path or namespace name, for those target kinds. */
    targetPath: text("target_path"),
    externalName: text("external_name")
  },
  (table) => [
    index("file_dependency_file_idx").on(table.fileId),
    index("file_dependency_target_file_idx").on(table.targetFileId),
    index("file_dependency_snapshot_kind_idx").on(table.snapshotId, table.targetKind),
    check(
      "file_dependency_target_kind_check",
      sql`${table.targetKind} in ('pending', 'file', 'directory', 'namespace', 'external', 'unresolved')`
    )
  ]
)

export const job = pgTable(
  "job",
  {
    id: uuid("id").primaryKey(),
    type: text("type").notNull(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => snapshot.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    currentPhase: text("current_phase"),
    completedPhases: text("completed_phases")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull(),
    lastError: text("last_error"),
    progress: jsonb("progress").$type<{
      phase: string
      completed: number
      total: number | null
      message: string | null
    }>(),
    /** Job-specific input (card jobs: card, feature and operation). */
    payload: jsonb("payload"),
    /** With type and snapshot, identifies duplicates (e.g. one active job per card); null for snapshot-wide jobs. */
    dedupeKey: text("dedupe_key"),
    lockedBy: text("locked_by"),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    runAfter: timestamp("run_after", { withTimezone: true }).defaultNow().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    finishedAt: timestamp("finished_at", { withTimezone: true })
  },
  (table) => [
    index("job_queue_idx")
      .on(table.runAfter, table.createdAt)
      .where(sql`${table.status} = 'queued'`),
    index("job_running_idx")
      .on(table.heartbeatAt)
      .where(sql`${table.status} = 'running'`),
    index("job_project_idx").on(table.projectId, table.createdAt),
    check("job_status_check", sql`${table.status} in ('queued', 'running', 'succeeded', 'failed', 'cancelled')`)
  ]
)

/** Append-only job log, streamed to the UI via SSE (LISTEN/NOTIFY on `job_events`). */
export const jobEvent = pgTable(
  "job_event",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => job.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    phase: text("phase"),
    message: text("message"),
    progress: jsonb("progress").$type<{
      phase: string
      completed: number
      total: number | null
      message: string | null
    }>(),
    createdAt: createdAt()
  },
  (table) => [index("job_event_job_idx").on(table.jobId, table.id)]
)

/**
 * Log of every model call: metadata only (phase, model, duration, tokens,
 * outcome). Prompts and answers are never stored here: they contain code.
 */
export const modelCall = pgTable(
  "model_call",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    jobId: uuid("job_id").references(() => job.id, { onDelete: "set null" }),
    // The log outlives deleted jobs and snapshots (audit): references become null.
    snapshotId: uuid("snapshot_id").references(() => snapshot.id, { onDelete: "set null" }),
    phase: text("phase").notNull(),
    task: text("task").notNull(),
    promptVersion: integer("prompt_version").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    attempt: integer("attempt").notNull(),
    outcome: text("outcome").notNull(),
    durationMs: integer("duration_ms").notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    error: text("error"),
    createdAt: createdAt()
  },
  (table) => [
    index("model_call_snapshot_idx").on(table.snapshotId, table.createdAt),
    index("model_call_job_idx").on(table.jobId),
    check("model_call_outcome_check", sql`${table.outcome} in ('success', 'invalid_output', 'error', 'timeout')`)
  ]
)
