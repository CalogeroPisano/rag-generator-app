# Data model

The schema is defined with Drizzle in `packages/db/src/schema/`; versioned migrations are in
`packages/db/migrations/`. The `vector` extension (pgvector) is enabled by the first migration.

## Tables

```mermaid
erDiagram
  user ||--o{ session : ""
  user ||--o{ account : ""
  user |o--o{ project : "created_by"
  user ||--o{ chat_conversation : ""
  project ||--o{ chat_conversation : ""
  chat_conversation ||--o{ chat_message : ""
  snapshot |o--o{ chat_message : "snapshot_id (set null)"
  project ||--o{ snapshot : ""
  project ||--o{ job : ""
  snapshot ||--o{ job : ""
  snapshot ||--o{ source_file : ""
  source_file ||--o{ symbol : ""
  source_file ||--o{ file_dependency : "file_id"
  source_file |o--o{ file_dependency : "target_file_id"
  source_blob |o--o{ source_file : "content_hash"
  job ||--o{ job_event : ""

  project {
    uuid id PK
    text name
    text source_type "zip | git"
    text repository_url
    text repository_ref
    text repository_username
    text encrypted_token "AES-256-GCM"
    text created_by FK
    timestamptz created_at
  }
  snapshot {
    uuid id PK
    uuid project_id FK
    text status "pending | acquiring | ready | failed"
    text commit_sha "Git"
    text content_hash "zip"
    uuid upload_id
    int included_files
    int excluded_files
    int masked_secrets
    text analysis_status "pending | running | ready | failed"
    text analyzer_version
    timestamptz analyzed_at
    int symbol_count
    int dependency_count
  }
  source_file {
    bigint id PK
    uuid snapshot_id FK
    text path "unique per snapshot"
    text language
    int size
    bool is_directory
    text excluded_reason
    text content_hash FK
    int line_count
    text encoding
    jsonb secrets "[{rule, line}]"
    text package_name "Java / Go"
    int parse_errors
  }
  symbol {
    bigint id PK
    uuid snapshot_id FK
    bigint file_id FK
    text kind "class | function | method | constant…"
    text name
    text qualified_name
    text container
    int start_line
    int end_line
    bool exported
    text signature
    text doc
  }
  file_dependency {
    bigint id PK
    uuid snapshot_id FK
    bigint file_id FK
    text specifier
    text kind "import | reexport | require | using…"
    int line
    text_array names
    text target_kind "pending | file | directory | namespace | external | unresolved"
    bigint target_file_id FK
    text target_path
    text external_name
  }
  source_blob {
    text hash PK "sha256 of the masked content"
    text content
  }
  job {
    uuid id PK
    text type "acquisition | analysis"
    uuid project_id FK
    uuid snapshot_id FK
    text status "queued | running | succeeded | failed | cancelled"
    text current_phase
    text_array completed_phases
    int attempts
    int max_attempts
    text last_error
    jsonb progress
    text locked_by
    timestamptz heartbeat_at
    timestamptz run_after
  }
  job_event {
    bigint id PK
    uuid job_id FK
    text kind
    text phase
    text message
    jsonb progress
  }
  chat_conversation {
    uuid id PK
    uuid project_id FK
    text user_id FK
    text title "first question"
    timestamptz updated_at
  }
  chat_message {
    uuid id PK
    uuid conversation_id FK
    text role "user | assistant"
    text content
    text status "complete | failed | interrupted"
    jsonb sources "[{cardId, featureId, featureName, title, status}]"
    int_array citations "source numbers, from 1"
    uuid snapshot_id FK
    text model
  }
```

The `user`, `session`, `account` and `verification` tables belong to Better Auth (generated with its CLI).

## Notes

- **project**: the Git token is always encrypted with `APP_ENCRYPTION_KEY` and bound to the project id (a value copied
  to another project cannot be decrypted).
- **snapshot**: an acquired version of the code. It is identified by the commit for Git and by the hash of the
  original tree (paths + content hashes) for zips.
- **source_file**: a file or an excluded directory. Excluded files only have metadata and a reason; excluded
  directories (`node_modules`, `dist`…) are a single entry with `is_directory = true`. `secrets` holds the rule and
  line of each masked credential, never the value.
- **source_blob**: masked contents, deduplicated by hash across snapshots and projects. Groundwork for incremental
  updates (phase 6).
- **snapshot (analysis columns)**: `analysis_status` is null until an analysis job is queued. `analyzer_version`
  records the version of the extraction rules (`ANALYZER_VERSION`), so snapshots analyzed with older rules can be
  recognised and re-analyzed. `symbol_count` and `dependency_count` are totals computed at the end of the analysis.
- **symbol**: a declaration. Lines refer to the masked content, which has the same lines as the original.
  `qualified_name` is the dotted path of the enclosing declarations (`OrderService.create`); `container` is the
  enclosing one (null at top level); `exported` follows the visibility rules of the language; `signature` is the
  declaration header without the body; `doc` the attached comment or docstring.
- **file_dependency**: an import as written (`specifier`, `line`, imported `names`) and its target, at the
  granularity native to the language: `file` (`target_file_id`), `directory` (Go package, Java `pkg.*`:
  `target_path`), `namespace` (C# `using`: `target_path`), `external` (library: `external_name`) or `unresolved`.
  It is `pending` between the `parse` and `resolve` phases.
- **job**: queue and state. Partial indexes for queued jobs (`run_after, created_at`) and running jobs
  (`heartbeat_at`).
- **job_event**: append-only log; the sequential id is used as the SSE event id.
- **job (types)**: `acquisition`, `analysis`, `understanding`, `card`, `indexing`, `questions`, `evaluation`. `payload`
  holds the input of card jobs (`{ cardId, featureId, operation }`) and test runs (`{ approvedOnly }`).
- **chat_conversation / chat_message**: chat conversations, private to their user, deleted with the project or the
  user. An assistant message keeps the cards given to the model (`sources`, copied: they stay readable after a
  regeneration) and the numbers its answer cites.

Rows read from the database are validated with the domain schemas (`packages/db/src/rows.ts`): an unexpected value
produces an explicit error instead of flowing into the domain.

### Model call log

`model_call` (schema `public`) records every HTTP call to a model: job, snapshot, phase, task (prompt id), prompt
version, provider, model, attempt (2 = correction request), outcome (`success | invalid_output | error | timeout`),
duration, input/output tokens and a short error (error name and HTTP status). Prompts and answers are never stored:
they contain code. The log survives the deletion of jobs and snapshots (references become null).

`snapshot` also tracks the AI understanding: `understanding_status` (`pending | running | ready | failed`, null until
requested), `understood_at`, `feature_count`, `card_count`.

## The `rag` schema

The knowledge produced by the AI understanding lives in its own Postgres schema, `rag`, kept apart from the
application tables. It is **self-contained**: no foreign key points to `public`. Projects, snapshots and files are
identified by copied ids, paths and revisions, so the schema can be read, exported or moved on its own. The
application deletes the knowledge of a snapshot itself (`rag.snapshot` cascades to every other `rag` table).

```mermaid
erDiagram
  rag_snapshot ||--o{ file_summary : ""
  rag_snapshot ||--o{ symbol_summary : ""
  rag_snapshot ||--o{ module_summary : ""
  rag_snapshot ||--o{ feature : ""
  feature ||--o| card : ""
  card ||--o{ card_reference : ""
  card ||--o| card_verification : ""
  feature |o--o{ correction : "feature_id (set null)"
  card ||--o{ chunk : ""
  rag_snapshot ||--o{ chunk : ""
  feature |o--o{ test_question : "feature_id (set null)"
  rag_snapshot ||--o{ test_run : ""
  test_run ||--o{ test_result : ""

  rag_snapshot {
    uuid id PK "same id as public.snapshot (no FK)"
    uuid project_id
    text project_name
    text source_type
    text repository_url
    text revision "commit sha or content hash"
    text language "en"
    text model
  }
  file_summary {
    bigint id PK
    uuid snapshot_id FK
    text path
    text language
    text content_hash "of the masked content"
    text summary
    int parts "model calls it was built from"
    int prompt_version
    text model
  }
  symbol_summary {
    bigint id PK
    uuid snapshot_id FK
    text path
    text qualified_name
    text kind
    int start_line
    int end_line
    text summary
  }
  module_summary {
    bigint id PK
    uuid snapshot_id FK
    text path "'' for the project root"
    int depth
    text summary
    int file_count
  }
  feature {
    uuid id PK
    uuid snapshot_id FK
    int position
    text name
    text description
    text_array files
    jsonb symbols "[{path, qualifiedName}]"
  }
  card {
    uuid id PK
    uuid snapshot_id FK
    uuid feature_id FK "unique"
    text status "generated | flagged | in_review | approved | excluded | needs_recheck"
    text title
    text summary
    jsonb content "CardContent"
    text source_revision
    int version
    int unreferenced_statements
    text reviewed_by "name copied, no FK"
    timestamptz reviewed_at
  }
  card_verification {
    uuid card_id PK "FK"
    int card_version
    jsonb statements "[{id, verdict, note}]"
    jsonb missing "[{section, text, references}]"
    int issues
    text model
    timestamptz verified_at
  }
  correction {
    uuid id PK
    uuid project_id "no FK"
    uuid feature_id FK "null when orphan"
    text feature_name
    text feature_key "normalized name"
    text text
    text author_id
    text author_name
    int applied_version
  }
  card_reference {
    bigint id PK
    uuid card_id FK
    text section
    int item_index
    text claim
    text path
    int start_line
    int end_line
  }
  chunk {
    bigint id PK
    uuid snapshot_id FK
    uuid card_id FK
    int card_version
    text section "overview or a card section"
    text text
    tsvector search_vector "generated: to_tsvector('simple', text)"
    vector embedding "any dimension"
    int dimensions
    text model
    int format_version
  }
  test_question {
    uuid id PK
    uuid project_id "no FK"
    uuid feature_id FK "null when orphan"
    text feature_name
    text feature_key
    text question
    text expected_answer
    text origin "generated | manual"
    text author_name
  }
  test_run {
    uuid id PK "= evaluation job id"
    uuid snapshot_id FK
    text status "running | ready | failed"
    text model
    text embedding_model
    int top_k
    bool approved_only
    int questions
    int retrieval_hits
    int first_hits
    float mrr
    int correct
    int partial
    int incorrect
    int no_answer
    int unjudged
  }
  test_result {
    bigint id PK
    uuid run_id FK
    uuid question_id "no FK"
    text question
    uuid expected_feature_id
    text expected_feature_name
    jsonb retrieved "[{featureId, featureName}]"
    int rank "null when not retrieved"
    text answer
    text_array cited_feature_ids
    text verdict "correct | partial | incorrect | no_answer"
    text note
  }
```

- **card.content** is the structured card (`CardContent` in `packages/ai/src/prompts/card.ts`): title, summary and the
  sections `behavior`, `configuration`, `parameters`, `limits`, `validationRules`, `errors`; every item carries its
  references. **card_reference** holds one row per cited range, for queries by file (phase 6).
- `unreferenced_statements` counts statements left without a valid reference; they count as verification issues.
- **card_verification**: the latest verification of a card; outdated when `card_version` < `card.version`.
- **correction**: reviewer corrections. They do not cascade from `rag.snapshot`: they belong to the project and to a
  feature name, survive new feature maps (re-attached by `feature_key`) and are deleted only with the project.
- The reviewer's name is copied into `card.reviewed_by` and `correction.author_name` (no link to the application's
  users, like the rest of `rag`).
- `prompt_version` and `model` are stored with every summary, feature and card.

- **chunk**: the embedding index of the chat. One overview chunk per card plus one per non-empty section. The vector
  column has no fixed dimension (`vector`): `model` and `dimensions` are stored with each row and a search only
  compares vectors of the configured model. Searches are exact (sequential scan of the snapshot's chunks through the
  `(snapshot_id, model)` index, no ANN index): a project has hundreds to a few thousand chunks. Chunks of an older
  card version are ignored until the card is re-indexed. `search_vector` (GIN index) serves the full-text search.
- **test_question**: like `correction`, belongs to the project and a feature name, re-attached after a new feature
  map, deleted only with the project. `model`/`prompt_version` are set for generated questions.
- **test_run / test_result**: a run of the test questions against the chat; results copy question and feature, which
  may change or disappear later. `rank` is the position of the expected card among the retrieved ones.

## Tables of the next phases

Phase 7 adds no tables: it exports the `rag` data of a project.

The `job` table also has `payload` (input of `card` jobs) and `dedupe_key` (one active job per card).

## Migrations

```bash
# after a change to packages/db/src/schema/*
pnpm db:generate     # creates packages/db/migrations/NNNN_*.sql
pnpm db:migrate      # applies the migrations (development)
```

In production they are applied by the `migrate` service of Docker Compose before web and worker start.
