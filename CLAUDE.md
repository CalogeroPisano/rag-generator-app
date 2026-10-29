# Code-to-RAG

Web application that rebuilds the features of a software project from its source code (zip or Git), produces
functional cards for end users, verifies and reviews them, and indexes them for a RAG chatbot. Commercial product,
installed **on premise**. Development is phased: see "Status" at the bottom.

## Commands

```bash
pnpm install                  # dependencies (exact versions, .npmrc save-exact)
docker compose up -d postgres # Postgres 17 + pgvector on localhost:5432
pnpm db:test:create           # once: creates code_to_rag_test for integration tests
pnpm db:migrate               # applies migrations (uses DATABASE_URL from .env)
pnpm dev                      # web on http://localhost:3000 (Vite)
pnpm dev:worker               # job worker (tsx watch)

pnpm typecheck | pnpm lint | pnpm format:check
pnpm test:unit                # no external services
pnpm test:integration         # needs TEST_DATABASE_URL (database name must end in _test)
pnpm build                    # web + worker bundles (dist/), incl. third-party license manifests
pnpm licenses:check           # license policy on distributed code (run after build)
pnpm licenses:report          # + report of every installed package (build tools included)
pnpm db:generate              # new Drizzle migration after editing adapters/outbound/postgres/src/schema
docker compose up -d --build  # full stack (web, worker, migrate, postgres); --profile ollama for Ollama
```

Human-facing documentation lives in `README.md` and `docs/` (architecture, flows, data model, security,
installation, licenses): **update it together with the code at every phase.**

Copy `.env.example` to `.env` first (`openssl rand -base64 32` for `APP_ENCRYPTION_KEY` and `BETTER_AUTH_SECRET`).

## Architecture

Hexagonal (ports and adapters, user's choice), with inbound and outbound ports and adapters kept apart. Details:
`docs/architecture.md`.

```
packages/core            the hexagon (Effect only: no node:*, no other package; ESLint-enforced)
  src/domain/              entities and schemas (model.ts, card.ts, code.ts, features.ts = featureKey), errors,
                           source rules (domain/source: filters, languages, limits, secrets = masking,
                           prepare = classify + decode + mask + hash, repository-url, paths)
  src/application/         use cases and pipelines (acquisition, analysis, understanding/, review, rag/, updates,
                           cancel, export/), queries.ts (read-only use cases), jobs.ts (job state/events, worker
                           loop operations, pipeline dispatch), prompts/, config (AppConfig), pipeline runner
  src/ports/inbound/       API of the use cases, one namespace per area: Projects, Jobs, Analysis, Knowledge, Rag,
                           Evaluation, Export (`import { Projects } from "@code-to-rag/core"`)
  src/ports/outbound/      repositories.ts, models.ts (LanguageModel, DecisionModel, EmbeddingModel, ModelCallRecorder,
                           AiError),
                           source.ts (UploadStore, SourceWorkspace), code-analyzer.ts, archive.ts (ZipArchive),
                           secret-box.ts, job-events.ts (JobEventsListener)
  entry points             "." (index.ts: domain + inbound namespaces + AppConfig), "./outbound" (outbound.ts:
                           domain + outbound ports), "./testing" (scripted models, RollupOutput)
adapters/inbound/web     @code-to-rag/web: TanStack Start routes, server functions, server routes; composition in
                         src/server/runtime.server.ts; Better Auth in src/server/auth.server.ts (shares the pool)
adapters/inbound/worker  @code-to-rag/worker: job loop over Jobs.*; composition in src/main.ts; migrate command
adapters/outbound/postgres    @code-to-rag/postgres: Drizzle schema + migrations, RepositoriesLive,
                              ModelCallRecorderLive, JobEventsListenerLive, SecretBoxLive (AES-256-GCM), testing
adapters/outbound/openai      @code-to-rag/openai: LanguageModelLive / EmbeddingModelLive (AI SDK +
                              OpenAI-compatible provider, undici fetch), AiConfig
adapters/outbound/ollama      @code-to-rag/ollama: DecisionModelLive (Ollama System One API `/v1/systemone`, undici
                              fetch, yes/no probabilities), DecisionConfig (DECISION_*)
adapters/outbound/filesystem  @code-to-rag/filesystem: StorageConfig (DATA_DIR) + FileAdaptersLive (UploadStore,
                              SourceWorkspace: zip extraction, isomorphic-git, tree scan), CodeAnalyzerLive
                              (tree-sitter, ANALYZER_VERSION), ZipArchiveLive (fflate)
```

Rules: inbound adapters import only `@code-to-rag/core` (their composition roots also the outbound adapters; their
tests also `/outbound` and `/testing`); outbound adapters import only `@code-to-rag/core/outbound`, never each
other. A new external dependency of a use case = a new outbound port + a `Layer` in an outbound adapter; a new
operation for the pages = a use case in `application/` exposed by an inbound port module. Ports are
`Context.Service` tags without a default layer; adapters export `…Live` layers. In development web and worker run
inside `adapters/inbound/*` (hence `DATA_DIR=../../../.data`).

### Data flow (phase 1)

1. Zip: browser streams the raw file to `POST /api/uploads` → `receiveUpload` → `UploadStore.receive` writes
   `DATA_DIR/uploads/<id>.zip` (size enforced while streaming, zip magic checked by core). Git: URL + optional read-only token.
2. `createProjectFn` (server function) → `createProject`: token sealed with `SecretBox` (AES-256-GCM, AAD = project
   id), project + snapshot + job inserted in one transaction.
3. Worker claims the job (`FOR UPDATE SKIP LOCKED`) and runs `acquisitionPipeline`: `fetch` (`SourceWorkspace`
   extracts/clones into `DATA_DIR/work/<jobId>`), `ingest` (`SourceWorkspace.scan` hands raw entries to core, which
   classifies, decodes, **masks secrets** (`prepareFile`) and stores), `finalize` (snapshot ready, temp data deleted).
4. Every job transition appends a `job_event` and `pg_notify('job_events', jobId)`; `GET /api/jobs/$jobId/events`
   (SSE) streams events, woken by `JobEventsListener` (LISTEN) with a 5 s polling fallback.

### Data flow (phase 2: static analysis)

1. `finalize` of the acquisition (and the "Rianalizza" action) calls `requestAnalysis`: queues an `analysis` job
   (`JobRepository.enqueue` returns the job already queued/running for the snapshot, under an advisory lock).
2. `analysisPipeline` (`core/src/application/analysis.ts`): `parse` (clears previous output, parses masked contents from
   Postgres in batches with `CodeAnalyzer` → `symbol` + `file_dependency` rows with target `pending`), `resolve`
   (`CodeAnalyzer.resolver` over paths, packages, tsconfig/jsconfig/package.json/go.mod → target kind
   `file|directory|namespace|external|unresolved`), `finalize` (counts, `analyzer_version`, status `ready`).
3. web-tree-sitter runs the grammars as WASM: `GRAMMARS_DIR` in the worker image (`dist/grammars`, copied by
   `scripts/vite-plugin-grammars.mjs`), otherwise resolved from `node_modules`. Bump `ANALYZER_VERSION`
   (`adapters/outbound/filesystem/src/parsing/analyzer.ts`) when extraction or resolution rules change.

### Data flow (phase 3: AI understanding)

1. Manual: "Genera schede" → `startUnderstanding` → `requestUnderstanding` (needs analysis ready) queues an
   `understanding` job. Only the worker runs it (the web calls models for the chat only, phase 5).
2. `understandingPipeline` (`core/src/application/understanding/pipeline.ts`): `prepare` (reset rag data) → `summarize-files`
   (code without tests + config files; large files split by `splitIntoParts`, then rolled up) → `summarize-modules`
   (`planModules`, bottom-up) → `map-features` (batched by token budget, `normalizeFeatures` / `mergeFeatures`) →
   `generate-cards` (`buildCardExcerpts`, `checkReferences`) → `finalize`. Summary/card phases skip stored items
   (resumable); an answer still invalid after the correction request skips the item.
3. `LanguageModel.generateObject`: AI SDK `streamText` (always streamed, over undici's `fetch` with no headers/body
   timeout: `adapters/outbound/openai/src/fetch.ts`) + `Output.object(jsonSchema(Schema.toJsonSchemaDocument))`, text parsed at the end,
   `maxRetries: 0` (Effect retry with backoff instead), `Effect.timeout`, `Semaphore` for `AI_CONCURRENCY`, decode with
   `Schema.toCodecJson`, one correction request, then `AiError(invalid_output)`. Every HTTP call → `ModelCallRecorder`
   → `public.model_call` (metadata only).
4. Output → schema **`rag`** (Drizzle `pgSchema("rag")`, `adapters/outbound/postgres/src/schema/rag.ts`): self-contained, **no
   foreign keys to `public`** (user's choice); the app deletes `rag.snapshot` rows itself (cascade inside `rag`).
   Summaries and cards are always in English. Bump a prompt's `version` whenever its text or schema changes.

### Data flow (phase 4: verification and review)

1. `verify-cards` (understanding) and card jobs use `verifyCard` (`core/src/application/understanding/cards.ts`,
   `card-verify` v2) on the **decision model** (`DecisionModel`, required, default `d1-omni`): one yes/no question per
   statement id `section.index` → probability → verdict by `VERIFY_*_THRESHOLD` (AppConfig `verification`), plus one
   question on missing rules (`missingProbability`/`missingSuspected`; it cannot list them). Ollama reads the state
   again for every question (input tokens = state × questions): statements citing code get only their cited lines
   (`citedExcerpts`, grouped by identical citations); the missing-rules question and unreferenced statements get the
   whole feature (`buildCardExcerpts` within `DECISION_CONTEXT_TOKENS`). → `rag.card_verification` (per card
   version); `saveVerification` moves only `generated`↔`flagged`. Older verifications (language model) keep notes and
   `missing` items.
2. Card operations needing a model are `card` jobs (`core/src/application/review.ts`, `cardPipeline`, single phase `process`):
   `job.payload` = `{ cardId, featureId, operation: verify|regenerate|correct }`, `dedupe_key` = feature id. The card is
   looked up by feature (regeneration replaces the card row; `saveCard` continues the version number).
3. Corrections (`rag.correction`) belong to project + normalized feature name (`featureKey`), are passed to every
   card prompt of the feature and re-attached by `reattachCorrections` after `replaceFeatures`. Manual edits
   (`editCard`) and decisions (`setCardStatus`) are immediate; references are checked against the snapshot's files.
4. Understanding and card jobs exclude each other per project (`JobRepository.active`).
5. `deleteProject`: refused if a job is running; `KnowledgeRepository.deleteProject` (rag rows + corrections) then
   `ProjectRepository.delete` (cascade, orphan blobs) and upload files.

### Data flow (phase 5: index, RAG chat, test questions)

1. `indexing` job (`core/src/application/rag/indexing.ts`, phase `index`), queued by `requestIndexing` (no-op without
   `EMBEDDING_MODEL`) after understanding `finalize`, card jobs (regenerate/correct), `editCard`, and the "Aggiorna /
   Ricostruisci" buttons; `enqueue({ dedupe: "queued" })`: a running job does not absorb new requests. Cards not
   excluded without chunks for (version, model, `CARD_CHUNK.version`) → `cardChunks` (overview + one per section) →
   `EmbeddingModel.embed` → `IndexRepository.saveChunks` (skipped if the card version changed). Bump `CARD_CHUNK`
   when the chunk text changes.
2. `rag.chunk`: `vector` without fixed dimension (+ `model`, `dimensions`), generated `tsvector` ('simple') with GIN.
   `retrieveCards` (`rag/retrieval.ts`): exact cosine search + full-text OR of the question words, Reciprocal Rank
   Fusion per card; status filter at query time (not excluded / approved only), outdated card versions ignored.
3. Chat: `POST /api/chat` (server route, SSE, CSRF middleware) → `askQuestion` (`rag/chat.ts`): conversation of the
   session user, question stored, `prepareAnswer` (top `RAG_TOP_CARDS` + cards cited by the previous answer, last 3
   exchanges, sized to `AI_CONTEXT_TOKENS - AI_CHAT_MAX_OUTPUT_TOKENS`), `LanguageModel.generateText` with
   `onDelta` (no retry once text was delivered), `citedSources`, answer stored (`failed` / `interrupted` with the
   partial text). Conversations in `public.chat_conversation` / `chat_message`.
4. Test questions (`rag/evaluation.ts`, `rag.test_question`, belong to project + feature name like corrections,
   `reattachQuestions` after `replaceFeatures`): `questions` job (phase `generate`, cards without generated ones) and
   `evaluation` job (`prepare` → `answer` → `finalize`, run id = job id, payload `{ approvedOnly }`): retrieval rank of
   the expected card, chat answer without history, `answer-judge` verdict; totals in `rag.test_run`.
5. Understanding refuses to start while card, questions or evaluation jobs are active, and vice versa.

### Data flow (phase 6: incremental updates)

1. "Nuova versione" → `requestNewVersion` (`core/src/application/updates.ts`; refused if any non-indexing job is active): snapshot
   with `base_snapshot_id` = the version in use (`project.current_snapshot_id`) + acquisition job. Everything reads the
   current snapshot (`ProjectSummary.currentSnapshot`), not the latest. Acquisition `finalize` discards a version with
   the base's commit/content hash (`unchangedBase`, `SnapshotRepository.discard` moves its jobs to the base).
2. Analysis `finalize` → `continueNewVersion`: records `snapshot.changes.files` (`diffFiles` on included files' hashes);
   base with cards → `requestUpdate` (`understanding` job, payload `{ baseSnapshotId }`), otherwise `promoteSnapshot`.
3. Same understanding phases, incremental when the payload has a base (`understanding/update.ts` pure helpers):
   `prepare` copies unchanged file summaries (same model + prompt version), `summarize-modules` copies modules outside
   `dirtyModules`, `map-features` uses `FEATURE_UPDATE` (`carryFeatures` + `applyFeatureUpdate`, features matched by
   `featureKey`), `generate-cards` copies (`copyCard`: status, version, verification, references, chunks; `change =
kept`), updates from the previous card (`changedFiles` in the CARD prompt, `baseVersion`, reviewed →
   `needs_recheck`, `change = updated`) or creates (`change = created`); `finalize` re-attaches corrections/questions,
   stores `changes.cards`, `promoteSnapshot` (→ `pruneSnapshots`, `SNAPSHOT_RETENTION`), `requestIndexing`.
4. `ensureNotUpdating` (any active job on a non-current snapshot) guards review, corrections, "Rigenera schede",
   question generation and test runs. Test runs are listed per project (all kept versions, with revision).

### Data flow (phase 7: knowledge export)

1. "Esporta" dialog → `getExportPreview` (`prepareExport` + `exportPreview`: rows per table, embedding models), then a
   plain download of `GET /api/projects/$projectId/export?format=jsonl|sql&approvedOnly=…` (server route, session
   check). No job, no file on disk; export only (no import: user's choice).
2. `prepareExport` (`core/src/application/export/export.ts`): current version with understanding ready, no understanding/card job
   on it (indexing → warning). `writeExport` opens `ExportRepository.open(scope)` (one pooled connection, `REPEATABLE
READ READ ONLY`, UTC, rolled back with the scope) and pages every table of `EXPORT_TABLES` (dependency order) by key;
   the route's `ReadableStream` waits for `pull` when its queue is full.
3. Scope (`adapters/outbound/postgres/src/export-repository.ts`, `inScope`): cards not excluded or approved only; features, references,
   verifications, chunks (current card version), corrections and test questions follow the cards; test runs over
   approved cards only when approved only. Rows are `to_jsonb` minus serial ids and generated columns.
4. Formats (`core/src/application/export/format.ts`, `EXPORT_FORMAT_VERSION`): zip (fflate `Zip`/`ZipDeflate`, synchronous) with
   `manifest.json` + `<table>.jsonl`; SQL script with DDL read from the catalog (`schemaStatements`: `CREATE … IF NOT
EXISTS`, serial → `bigserial`), deletion of the project's rows, multi-row INSERTs with typed literals
   (`sqlLiteral`), header comments stripped of control characters (`commentText`). Any new `rag` table must be added to
   `EXPORT_TABLES` and `inScope` (the export fails on unknown tables; the integration test compares the recreated
   catalog with the migrated one).

### Jobs and phases

- A phase has a stable `name`, takes only the job, is **idempotent** (clears/overwrites what a previous attempt
  produced) and persists its output before returning. This is the contract that lets phases become activities of
  Effect durable workflows later.
- The runner (`core/src/application/pipeline.ts`) records `completed_phases`; a failed job resumes from the failed phase.
  `PhaseError.retryable` decides between automatic retry (exponential backoff, `max_attempts`) and immediate failure.
- Worker heartbeat every 15 s; `requeueStale` re-queues jobs of dead workers (or fails them when out of attempts),
  never the caller's own. Runs are fenced by `job.attempts` (heartbeat/succeed/fail/scheduleRetry/release take the
  attempt): a run whose job was cancelled ("Interrompi", `cancelJob`) or claimed again is interrupted by its worker.
  SIGTERM interrupts the worker: running jobs are released without consuming an attempt.

### Security rules

- Source code content is stored **only after masking** (`core/src/domain/source/secrets.ts`, applied by `prepareFile` in the acquisition `ingest`); unmasked originals are never
  persisted (temp area is deleted) and must never be logged or sent to a model. Masking preserves line numbers.
  Unquoted `key = value` masking is limited to configuration-like languages (`configLanguages`): in code it would
  mask expressions (`password: z.string()`) and break parsing.
- Findings record rule + line only, never the secret.
- Models receive masked content only; prompts/answers are never logged or stored in `model_call` (errors: name +
  HTTP status only). Never pass a string model id to the AI SDK (it would resolve through the Vercel AI Gateway).
  Model HTTP calls use `modelFetch` (undici), never the global fetch.
- The chat sends models only the question, the conversation and card text (never code); chat answers are stored in
  `chat_message` only and rendered as plain text. Conversations are filtered by the session user everywhere.
- Git tokens: encrypted at rest, passed to isomorphic-git only via `onAuth`, never in URLs, logs or errors.
- Zip: paths sanitised (`sanitizeArchivePath` + `resolveInside`), symlinks never materialised, sizes enforced on
  inflated bytes (headers are not trusted).
- Every server function touching data uses `authMiddleware`; server routes check the session themselves.
- Errors crossing to the client go through `runEffect` (`adapters/inbound/web/src/server/run.server.ts`): only tagged,
  user-facing errors keep their message.

## Conventions

- TypeScript strict + `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `erasableSyntaxOnly` (no enums,
  no parameter properties). Imports between files of a package use `.ts` extensions.
- **Stable APIs only.** Effect 4.0.5: check `@stability` in `node_modules/effect/dist/*.d.ts` before using an API;
  `effect/sql`, `effect/http`, `effect/process`, `effect/workflow`, `effect/ai`, `FileSystem`, `Path`, `Crypto`,
  `@effect/sql-pg`, `@effect/vitest`, `@effect/platform-node` are **unstable**: do not use without asking. Use Node
  built-ins wrapped in `Effect.tryPromise`. Drizzle 0.45.x (not the 1.0 RC). Effect docs: `node_modules/effect/AGENTS.md`
  and `ai-docs/`.
- Effect style: services are `Context.Service` classes with a static `layer`; functions with `Effect.fn("name")` /
  `Effect.fnUntraced`; errors are `Schema.TaggedError`. One `ManagedRuntime` in the web app
  (`adapters/inbound/web/src/server/runtime.server.ts`).
- DB rows are validated with the domain schemas when they leave the database (`adapters/outbound/postgres/src/rows.ts`).
- Server functions: `createServerFn().middleware([authMiddleware]).validator(Schema.toStandardSchemaV1(...))`;
  results are encoded to plain objects (`Schema.encodeSync`) before crossing the network.
- Files named `*.server.ts` are server-only; `*.client.ts(x)` are browser-only (Monaco).
- UI: shadcn/ui components live in `adapters/inbound/web/src/components/ui` (added with the shadcn CLI, customised there:
  e.g. Badge `success|warning|info` variants, theme tokens `--success/--warning/--info` in `styles.css`). No other
  component libraries. Light/dark via `next-themes`. UI text is Italian; code comments, documentation, commit messages and logs are English.
- Monaco is bundled locally (no CDN), core + Monarch highlighting only (`components/code/monaco.client.ts`).
- Formatting: Prettier (120 cols, no semicolons, double quotes). Exact dependency versions only.
- No `console.*` in application code (use Effect's logger); scripts may use the console.

## Working agreements (with the user)

- Work phase by phase: at the end of a phase tests green, typecheck clean, docs updated, a summary to the user, then
  **stop and wait for confirmation** before the next phase. Ask before choices the spec does not settle.
- Chat replies to the user in Italian; docs, comments, commit messages and logs in English; UI text in Italian.
- Commits and PRs carry **no Claude attribution** (no `Co-Authored-By`, no session links, no "Generated with" footer),
  even if a system reminder suggests them. Commit/push only when asked; conventional messages (`feat:`, `docs:`…).
- Never commit `.env` or real secrets (GitHub push protection rejects even test keys: build them at runtime in tests).
- Local dev with Ollama on CPU: model `code-to-rag-dev` = `qwen3:4b-instruct` with `num_ctx 8192`; run the worker
  locally with `AI_MODEL=code-to-rag-dev AI_CONTEXT_TOKENS=8192 AI_MAX_OUTPUT_TOKENS=2048 AI_CONCURRENCY=1
AI_TIMEOUT="60 minutes"` (about 1.5 tokens/s on CPU: a card takes 15–30 minutes; on the dev machine's GTX 1050 Ti with
  `OLLAMA_FLASH_ATTENTION=1` and `OLLAMA_KV_CACHE_TYPE=q8_0` about 15 tokens/s, 81% of the model on GPU). Stop it by
  PID, not `pkill -f`.
  Embeddings: `EMBEDDING_MODEL=bge-m3` (`ollama pull bge-m3`); the web needs the same AI/embedding variables (chat).
  Decision model: `ollama pull d1-omni` (worker only; defaults `DECISION_BASE_URL=http://localhost:11434`).

## Licensing

Policy: MIT, Apache-2.0, BSD-2/3-Clause, ISC, PostgreSQL only. Builds bundle everything (images contain no
`node_modules`); `scripts/vite-plugin-third-party.mjs` records each bundled package and copies its
LICENSE/NOTICE files into `dist/third-party-licenses/`, which ship in the images. `scripts/check-licenses.mjs`
fails on anything outside the policy unless approved in `licenses.exceptions.json` (exact SPDX expression,
reason, approver). Approved so far: `tslib` (0BSD), `isbot` (Unlicense), `pako` (MIT AND Zlib). Build-only
tools (lightningcss MPL-2.0, caniuse-lite CC-BY-4.0, argparse Python-2.0) are not distributed. Check the license
of every new dependency before adding it.

## Decisions (beyond the spec)

- Architecture: hexagonal (user's choice) with inbound and outbound ports and adapters apart (user's choice):
  `adapters/inbound/{web,worker}`, `adapters/outbound/{postgres,openai,filesystem}`; inbound ports are modules of
  use-case functions exposed as namespaces (user's choice, not Effect services). Prompts and output schemas belong to
  core (application), the openai adapter only transports requests. Secret encryption is a postgres adapter
  (encryption at rest); uploads, work areas, tree-sitter and zip writing are filesystem adapters; content hashes in
  core use Web Crypto (`crypto.subtle`).
- Database access: Drizzle ORM + `pg` (user's choice: `@effect/sql-pg` is unstable in Effect 4.0.5).
- Authentication: Better Auth (email/password), sharing the app's pg pool; telemetry disabled. The first account
  can always sign up (bootstrap); later sign-ups only with `AUTH_ALLOW_SIGNUP=true`. Roles: not yet.
- Masked file contents stored in Postgres (`source_blob`, deduplicated by hash); nothing on disk after acquisition.
- Git via isomorphic-git (pure JS; no git binary in the images).
- Web production server: srvx (bundled `serve.js`); Nitro 3 is still beta.
- TypeScript 6.0.x (typescript-eslint does not support 6.1+ / 7 yet).
- AI knowledge in a separate Postgres schema `rag`, self-contained (no FKs to `public`); cards/summaries in English;
  understanding started manually as its own job. Dev model: Ollama `qwen3:4b-instruct` (CPU).
- Phase 5 (user's choices): index = every card except excluded ones (status shown, "approved only" filter); chat in
  the web process, streamed, conversations stored per user, in-app only (no external API yet); multilingual
  embeddings (`bge-m3` suggested) + hybrid search (pgvector + full-text, RRF), exact search (no ANN index); test
  questions generated + manual, test runs judged by the model. Model calls use undici's fetch (MIT).
- Phase 6 (user's choices): new versions started manually ("Nuova versione"), the card update follows automatically;
  changed cards are updated from the previous ones and reviewed ones return to `needs_recheck`, unchanged ones are
  copied with their review; incremental feature map; the last `SNAPSHOT_RETENTION` (3) versions are kept.
- Decision model (user's choice, to cut analysis time): card verification by `d1-omni` (Liquid AI, LFM Open License
  v1.0: commercial use only below 10 M$ annual revenue, documented in docs/licenses.md) through Ollama's System One
  API; required, no fallback to the language model. Measured on the dev project (8 cards, 103 statements): 37 min with
  qwen3:4b → about 30 s. Feature triage before cards and file triage before summaries (points 2 and 3) are pending
  the user's feedback.
- Phase 7 (user's choices): export only, no import; everything of the version in use including embeddings; scope
  chosen at every export (all but excluded / approved only); SQL with the same `rag` schema (re-runnable, replaces the
  project's rows); direct streamed download, no job.

## Status

- Phase 1 (foundations and acquisition): implemented.
- Phase 2 (static analysis with tree-sitter: TS/JS, Java, C#, Go, Python): implemented.
- Phase 3 (AI understanding: summaries, feature map, cards with line references, `rag` schema): implemented.
- Phase 4 (verification and review, project deletion): implemented.
- Phase 5 (embedding index in pgvector, RAG chat with citations, test questions; no 5-minute time-to-first-token
  limit): implemented.
- Phase 6 (incremental updates on new versions of the code): implemented.
- Phase 7 (per-project knowledge export: JSONL archive + manifest, SQL script for another Postgres; no import, user's
  choice): implemented.
- All planned phases are implemented.
