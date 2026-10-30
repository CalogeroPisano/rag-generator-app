/**
 * Knowledge derived by the AI understanding, in its own Postgres schema `rag`.
 *
 * The schema is self-contained: it has no foreign keys to the application
 * tables (`public`). Projects, snapshots and files are identified by copied
 * ids, paths and revisions, so that the knowledge base can be read, exported or
 * moved on its own. The application deletes the rows of a snapshot itself
 * (`rag.snapshot` cascades to everything else).
 */
import { sql } from "drizzle-orm"
import {
  bigserial,
  boolean,
  check,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core"

export const rag = pgSchema("rag")

const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull()

/** One analyzed version of a project: the root of everything else in `rag`. */
export const ragSnapshot = rag.table(
  "snapshot",
  {
    /** Same id as the application snapshot (`public.snapshot.id`), not a foreign key. */
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id").notNull(),
    projectName: text("project_name").notNull(),
    sourceType: text("source_type").notNull(),
    repositoryUrl: text("repository_url"),
    /** Commit sha (Git) or content hash (zip) of the analyzed code. */
    revision: text("revision").notNull(),
    /** Language of summaries and cards. */
    language: text("language").notNull(),
    model: text("model").notNull(),
    createdAt: createdAt()
  },
  (table) => [index("rag_snapshot_project_idx").on(table.projectId)]
)

const snapshotId = () =>
  uuid("snapshot_id")
    .notNull()
    .references(() => ragSnapshot.id, { onDelete: "cascade" })

export const fileSummary = rag.table(
  "file_summary",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    snapshotId: snapshotId(),
    path: text("path").notNull(),
    language: text("language").notNull(),
    /** Hash of the masked content that was summarized (reuse on unchanged files, phase 6). */
    contentHash: text("content_hash").notNull(),
    summary: text("summary").notNull(),
    /** Number of model calls (parts) the summary was built from. */
    parts: integer("parts").notNull(),
    promptVersion: integer("prompt_version").notNull(),
    model: text("model").notNull(),
    createdAt: createdAt()
  },
  (table) => [uniqueIndex("rag_file_summary_path_idx").on(table.snapshotId, table.path)]
)

export const symbolSummary = rag.table(
  "symbol_summary",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    snapshotId: snapshotId(),
    path: text("path").notNull(),
    qualifiedName: text("qualified_name").notNull(),
    kind: text("kind").notNull(),
    startLine: integer("start_line").notNull(),
    endLine: integer("end_line").notNull(),
    summary: text("summary").notNull()
  },
  (table) => [index("rag_symbol_summary_path_idx").on(table.snapshotId, table.path)]
)

/** Summary of a directory, built from its files and sub-directories. `path` is "" for the project root. */
export const moduleSummary = rag.table(
  "module_summary",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    snapshotId: snapshotId(),
    path: text("path").notNull(),
    depth: integer("depth").notNull(),
    summary: text("summary").notNull(),
    fileCount: integer("file_count").notNull(),
    promptVersion: integer("prompt_version").notNull(),
    model: text("model").notNull(),
    createdAt: createdAt()
  },
  (table) => [uniqueIndex("rag_module_summary_path_idx").on(table.snapshotId, table.path)]
)

export const feature = rag.table(
  "feature",
  {
    id: uuid("id").primaryKey(),
    snapshotId: snapshotId(),
    position: integer("position").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    files: text("files")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Involved declarations: `[{ path, qualifiedName }]`. */
    symbols: jsonb("symbols").$type<Array<{ path: string; qualifiedName: string }>>().notNull().default([]),
    /** Probability (decision model) that the user documentation would describe the feature; null before the triage. */
    userFacing: doublePrecision("user_facing"),
    /** Only technical: no card is generated unless a reviewer asks for one. */
    technical: boolean("technical").default(false).notNull(),
    promptVersion: integer("prompt_version").notNull(),
    model: text("model").notNull(),
    createdAt: createdAt()
  },
  (table) => [index("rag_feature_snapshot_idx").on(table.snapshotId, table.position)]
)

export const card = rag.table(
  "card",
  {
    id: uuid("id").primaryKey(),
    snapshotId: snapshotId(),
    featureId: uuid("feature_id")
      .notNull()
      .references(() => feature.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    /** Structured content (`CardContent`), references already checked against the files. */
    content: jsonb("content").notNull(),
    /** Revision of the code the card was generated from. */
    sourceRevision: text("source_revision").notNull(),
    version: integer("version").notNull().default(1),
    /** Statements without any valid reference (candidates for verification). */
    unreferencedStatements: integer("unreferenced_statements").notNull().default(0),
    /**
     * How an incremental update produced the card: `kept` (copied, code unchanged), `updated` (rewritten from the
     * previous version) or `created` (new feature). Null when written by a full understanding.
     */
    change: text("change"),
    /** Last manual edit or review decision (name copied: no link to the application's users). */
    reviewedBy: text("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    promptVersion: integer("prompt_version").notNull(),
    model: text("model").notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date())
  },
  (table) => [
    uniqueIndex("rag_card_feature_idx").on(table.featureId),
    index("rag_card_snapshot_idx").on(table.snapshotId),
    check(
      "rag_card_status_check",
      sql`${table.status} in ('generated', 'flagged', 'in_review', 'approved', 'excluded', 'needs_recheck')`
    ),
    check("rag_card_change_check", sql`${table.change} is null or ${table.change} in ('kept', 'updated', 'created')`)
  ]
)

/** One cited source range of a card statement. */
export const cardReference = rag.table(
  "card_reference",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    cardId: uuid("card_id")
      .notNull()
      .references(() => card.id, { onDelete: "cascade" }),
    section: text("section").notNull(),
    /** Position of the statement in its section. */
    itemIndex: integer("item_index").notNull(),
    claim: text("claim").notNull(),
    path: text("path").notNull(),
    startLine: integer("start_line").notNull(),
    endLine: integer("end_line").notNull()
  },
  (table) => [
    index("rag_card_reference_card_idx").on(table.cardId),
    index("rag_card_reference_path_idx").on(table.path)
  ]
)

/** Automatic verification of a card version (one row per card, replaced at every verification). */
export const cardVerification = rag.table("card_verification", {
  cardId: uuid("card_id")
    .primaryKey()
    .references(() => card.id, { onDelete: "cascade" }),
  /** Card version that was verified: an older one means the verification is outdated. */
  cardVersion: integer("card_version").notNull(),
  /** `[{ id: "section.index", verdict, note, probability? }]` */
  statements: jsonb("statements").notNull(),
  /** `[{ section, text, references }]`: what the code shows and the card does not say. */
  missing: jsonb("missing").notNull(),
  issues: integer("issues").notNull(),
  promptVersion: integer("prompt_version").notNull(),
  model: text("model").notNull(),
  verifiedAt: timestamp("verified_at", { withTimezone: true }).defaultNow().notNull()
})

/**
 * Reviewer corrections. They outlive regenerations: they belong to the project
 * and to a feature *name*; `feature_id` points to the feature of the current
 * map with that name, if any (re-attached after every new feature map).
 */
export const correction = rag.table(
  "correction",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id").notNull(),
    featureId: uuid("feature_id").references(() => feature.id, { onDelete: "set null" }),
    featureName: text("feature_name").notNull(),
    /** Normalized feature name used to re-attach the correction. */
    featureKey: text("feature_key").notNull(),
    text: text("text").notNull(),
    authorId: text("author_id").notNull(),
    authorName: text("author_name").notNull(),
    /** Card version that applied it last; null while pending. */
    appliedVersion: integer("applied_version"),
    createdAt: createdAt()
  },
  (table) => [
    index("rag_correction_project_idx").on(table.projectId, table.featureKey),
    index("rag_correction_feature_idx").on(table.featureId)
  ]
)

// ── Phase 5: embedding index, test questions and runs ──────────────────────

/**
 * pgvector column without a fixed dimension: the dimension depends on the
 * embedding model, recorded next to every vector. Searches compare vectors of
 * one model only.
 */
const vector = customType<{ data: ReadonlyArray<number>; driverData: string }>({
  dataType: () => "vector",
  toDriver: (value) => `[${value.join(",")}]`,
  fromDriver: (value) => JSON.parse(value) as Array<number>
})

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" })

/**
 * One indexed text unit of a card: its overview or one of its sections, with
 * the embedding and a full-text vector ('simple' configuration: no stemming,
 * cards are in English and questions may not be).
 */
export const chunk = rag.table(
  "chunk",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    snapshotId: snapshotId(),
    cardId: uuid("card_id")
      .notNull()
      .references(() => card.id, { onDelete: "cascade" }),
    /** Card version the chunk was built from: older versions are ignored by searches and re-indexed. */
    cardVersion: integer("card_version").notNull(),
    /** `overview` or a card section. */
    section: text("section").notNull(),
    text: text("text").notNull(),
    searchVector: tsvector("search_vector")
      .notNull()
      .generatedAlwaysAs(sql`to_tsvector('simple', "text")`),
    embedding: vector("embedding").notNull(),
    dimensions: integer("dimensions").notNull(),
    model: text("model").notNull(),
    /** Version of the chunk text format (`CARD_CHUNK`). */
    formatVersion: integer("format_version").notNull(),
    createdAt: createdAt()
  },
  (table) => [
    index("rag_chunk_card_idx").on(table.cardId),
    index("rag_chunk_snapshot_model_idx").on(table.snapshotId, table.model),
    index("rag_chunk_search_idx").using("gin", table.searchVector)
  ]
)

/**
 * Test questions of the chat. Like corrections they belong to the project and
 * to a feature name, survive new feature maps (re-attached by `feature_key`)
 * and are deleted only with the project.
 */
export const testQuestion = rag.table(
  "test_question",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id").notNull(),
    featureId: uuid("feature_id").references(() => feature.id, { onDelete: "set null" }),
    featureName: text("feature_name").notNull(),
    featureKey: text("feature_key").notNull(),
    question: text("question").notNull(),
    expectedAnswer: text("expected_answer"),
    origin: text("origin").notNull(),
    /** Reviewer who wrote it (name copied); null for generated questions. */
    authorName: text("author_name"),
    /** Model and prompt version of generated questions. */
    model: text("model"),
    promptVersion: integer("prompt_version"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date())
  },
  (table) => [
    index("rag_test_question_project_idx").on(table.projectId, table.featureKey),
    index("rag_test_question_feature_idx").on(table.featureId),
    check("rag_test_question_origin_check", sql`${table.origin} in ('generated', 'manual')`)
  ]
)

/** A test run of the chat over the test questions (same id as its evaluation job). */
export const testRun = rag.table(
  "test_run",
  {
    id: uuid("id").primaryKey(),
    snapshotId: snapshotId(),
    status: text("status").notNull(),
    model: text("model").notNull(),
    embeddingModel: text("embedding_model").notNull(),
    topK: integer("top_k").notNull(),
    approvedOnly: boolean("approved_only").notNull(),
    questions: integer("questions").notNull(),
    retrievalHits: integer("retrieval_hits").notNull().default(0),
    firstHits: integer("first_hits").notNull().default(0),
    mrr: doublePrecision("mrr").notNull().default(0),
    correct: integer("correct").notNull().default(0),
    partial: integer("partial").notNull().default(0),
    incorrect: integer("incorrect").notNull().default(0),
    noAnswer: integer("no_answer").notNull().default(0),
    unjudged: integer("unjudged").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true })
  },
  (table) => [
    index("rag_test_run_snapshot_idx").on(table.snapshotId, table.startedAt),
    check("rag_test_run_status_check", sql`${table.status} in ('running', 'ready', 'failed')`)
  ]
)

/** Outcome of one question in a run; question and feature are copied (they may change or disappear later). */
export const testResult = rag.table(
  "test_result",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => testRun.id, { onDelete: "cascade" }),
    questionId: uuid("question_id").notNull(),
    question: text("question").notNull(),
    expectedFeatureId: uuid("expected_feature_id").notNull(),
    expectedFeatureName: text("expected_feature_name").notNull(),
    /** `[{ featureId, featureName }]`, best first. */
    retrieved: jsonb("retrieved").notNull(),
    rank: integer("rank"),
    answer: text("answer").notNull(),
    citedFeatureIds: text("cited_feature_ids")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    verdict: text("verdict"),
    note: text("note"),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex("rag_test_result_question_idx").on(table.runId, table.questionId),
    check(
      "rag_test_result_verdict_check",
      sql`${table.verdict} is null or ${table.verdict} in ('correct', 'partial', 'incorrect', 'no_answer')`
    )
  ]
)
