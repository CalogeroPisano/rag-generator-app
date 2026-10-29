# Architecture

## Overview

Code-to-RAG consists of three processes and one database:

```mermaid
flowchart LR
  browser["Browser<br/>(React, shadcn/ui, Monaco)"]
  subgraph server["On-premise installation (Docker Compose)"]
    web["web<br/>TanStack Start + srvx"]
    worker["worker<br/>job pipeline"]
    migrate["migrate<br/>(one-shot)"]
    pg[("PostgreSQL 17<br/>+ pgvector")]
    data[["/data volume<br/>uploads, work areas"]]
    ollama["ollama<br/>(optional, or any OpenAI-<br/>compatible endpoint)"]
  end
  git["Git server<br/>(internal or public)"]

  browser -- "HTTP: pages, server functions,<br/>upload, SSE (progress, chat)" --> web
  web -- "SQL, LISTEN" --> pg
  worker -- "SQL, NOTIFY" --> pg
  migrate -- "migrations" --> pg
  web -- "writes uploaded zips" --> data
  worker -- "reads zips, extracts, clones" --> data
  worker -- "HTTPS clone" --> git
  worker -- "chat completions, embeddings<br/>(masked code only)" --> ollama
  web -- "chat answer, question embedding<br/>(cards only)" --> ollama
```

- **web** serves the interface, exposes the server functions (typed RPCs used by the pages) and a few server
  routes: zip upload, SSE progress stream, RAG chat stream, authentication endpoints. It never runs long tasks; the
  only model calls it makes are those of the chat (embedding of the question, streamed answer).
- **worker** takes jobs from the queue in PostgreSQL and runs the pipeline phases. Several instances can run at once.
- **migrate** applies the database migrations when the stack starts, then exits; web and worker start only after it.
- **PostgreSQL** is the only persistent store: application data, file contents (already masked), job queue, events,
  sessions, chat conversations (schema `public`) and the knowledge produced by the AI understanding, its embedding
  index (pgvector) and the test questions (schema `rag`, see [Data model](data-model.md#the-rag-schema)).
- The **/data** volume is shared by web and worker: it holds uploaded zips waiting to be processed and the temporary
  work areas of the jobs. It is emptied at the end of every acquisition.

## Monorepo

pnpm workspaces, TypeScript in strict mode everywhere.

```mermaid
flowchart BT
  analysis["packages/analysis<br/>zip, Git, filters, languages,<br/>credential masking, tree-sitter"]
  core["packages/core<br/>domain, ports, pipeline,<br/>use cases"]
  db["packages/db<br/>Drizzle, migrations,<br/>repositories"]
  ai["packages/ai<br/>AI SDK client,<br/>prompts"]
  web["apps/web"]
  worker["apps/worker"]

  core --> analysis
  core --> ai
  db --> core
  db --> ai
  web --> db
  web --> core
  worker --> db
  worker --> core
```

| Package             | Responsibility                                                                                                                                                                                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/analysis` | Acquisition primitives with no application state: safe zip reading, Git clone, file classification, language detection, credential masking, tree scanning; tree-sitter parsing (symbols, imports) and import resolution.                                                                                                        |
| `packages/core`     | Domain: Effect schemas (entities, inputs), typed errors, configuration, secret encryption, repository **ports**, pipeline engine, acquisition, analysis, understanding (full and incremental), indexing and test pipelines, RAG retrieval and chat, versions of the code, knowledge export, use cases.                          |
| `packages/db`       | Implementation of the ports with Drizzle and `pg`, schema and migrations, `LISTEN/NOTIFY` listener, test support.                                                                                                                                                                                                               |
| `packages/ai`       | AI layer: `LanguageModel` (structured answers with schema validation and one correction request, streamed text answers) and `EmbeddingModel` services over the AI SDK (OpenAI-compatible provider) with retry, timeout and concurrency limit; `AiConfig`; `ModelCallRecorder` port; versioned prompts and their output schemas. |
| `apps/web`          | Interface and HTTP API.                                                                                                                                                                                                                                                                                                         |
| `apps/worker`       | Job process and migration command.                                                                                                                                                                                                                                                                                              |

### Ports and adapters

`core` does not know the database: it defines the repository interfaces (`ProjectRepository`, `SnapshotRepository`,
`JobRepository`, `AnalysisRepository`, `UnderstandingRepository`, `KnowledgeRepository`, `IndexRepository`,
`EvaluationRepository`, `ChatRepository`, `ExportRepository` in `packages/core/src/ports.ts`; `ModelCallRecorder` in `packages/ai`) as Effect
services. `db` implements them as `Layer`s. The
applications compose the layers at startup. The domain and the pipeline therefore stay testable and independent of
the persistence technology, and the dependency always goes from `db` to `core`, never the other way round.

## Technologies

| Area            | Choice                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------- |
| Language        | TypeScript 6.0 strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`)                  |
| Web             | TanStack Start 1.x (React 19, Vite 8), TanStack Query, srvx as the Node server in production      |
| Interface       | shadcn/ui + Tailwind CSS 4, components in the repository; `next-themes` for theming; local Monaco |
| Domain          | Effect 4 (stable APIs only): `Context.Service` + `Layer` services, `Schema.TaggedError` errors    |
| Validation      | Effect Schema for server function inputs, database rows, events                                   |
| Database        | PostgreSQL 17 + pgvector, Drizzle ORM 0.45 + `pg`, versioned migrations with drizzle-kit          |
| Authentication  | Better Auth (email and password), sharing the database pool                                       |
| Acquisition     | fflate (decompression), isomorphic-git (clone, no git binary in the images)                       |
| Static analysis | web-tree-sitter (WebAssembly) with the official grammars of each language, no native modules      |
| AI              | Vercel AI SDK 7 (`ai`) + `@ai-sdk/openai-compatible`; no Vercel AI Gateway; undici for model HTTP |
| RAG             | pgvector (exact cosine search) + PostgreSQL full-text search, fused with Reciprocal Rank Fusion   |
| Export          | fflate (streamed zip of JSONL files); SQL script with the DDL read from the PostgreSQL catalog    |
| Tests           | Vitest (unit, and integration on a real PostgreSQL)                                               |
| Distribution    | Multi-stage Docker: images with JavaScript bundles only, no `node_modules`                        |

### Running effects

- **Web**: a single `ManagedRuntime` (`apps/web/src/server/runtime.server.ts`), built once per process with
  configuration, encryption, database, repositories, the event listener and the chat and embedding models. Server functions run Effect programs
  through `runEffect`, which turns expected errors into HTTP responses (404, 400, 413) and logs the others without
  exposing them to the client.
- **Worker**: the main program runs in a fiber; `SIGTERM`/`SIGINT` interrupt it and running jobs are returned to the
  queue.

## Decisions

| Decision                                                  | Rationale                                                                                                                         |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Drizzle instead of `@effect/sql-pg`                       | In Effect 4.0.5 the SQL modules, drivers and platform integrations are marked unstable; only stable APIs are used.                |
| Job queue in PostgreSQL (`FOR UPDATE SKIP LOCKED`)        | No extra infrastructure on premise; consistent transactions between job state and events.                                         |
| File contents in PostgreSQL (`source_blob`, deduplicated) | A single store to back up; versions share unchanged files and are compared by hash; no source files on disk after acquisition.    |
| `LISTEN/NOTIFY` for progress                              | Real-time updates without a broker; the events table remains the source of truth.                                                 |
| isomorphic-git                                            | No (GPL) git binary in the images; the token only goes through the authentication callback.                                       |
| Full bundles for web and worker                           | Small images, exact license check on what is distributed.                                                                         |
| srvx as the production server                             | Nitro 3 is still in beta.                                                                                                         |
| Better Auth                                               | Product owner's choice; telemetry disabled.                                                                                       |
| tree-sitter via WebAssembly                               | Same build everywhere (no native compilation); grammars ship as `.wasm` assets in the worker image (`GRAMMARS_DIR`).              |
| Native dependency targets (file, directory, namespace)    | Go packages, Java wildcard imports and C# namespaces do not map to a single file; nothing is invented.                            |
| Analysis as a separate job                                | Can be re-run on its own (new analyzer version) without re-acquiring the code.                                                    |
| AI knowledge in a separate `rag` schema, no foreign keys  | Product owner's choice: the knowledge base can be read, exported or moved on its own; the application deletes it explicitly.      |
| Summaries and cards in English                            | Product owner's choice; prompts are in English too.                                                                               |
| Understanding started manually, as its own job            | It costs model time: the user decides when; it can be re-run without re-acquiring or re-analyzing.                                |
| Own validation and correction loop around the AI SDK      | Effect Schema validates the answer; one correction request, then a typed error; every HTTP call is logged.                        |
| Verification automatic and on demand                      | Every card is checked against the code before anyone reviews it; a reviewer can re-check after a change.                          |
| Card operations as jobs (`card`, one per card)            | Model calls take minutes on modest hardware; the page polls the job and refreshes the card.                                       |
| Corrections tied to the feature name                      | Product owner's choice: they survive regenerations and new feature maps; unmatched ones stay visible as orphans.                  |
| Project deletion refused while a job runs                 | Avoids a worker writing to a deleted project; queued jobs are deleted with it.                                                    |
| Interface in Italian; code, docs and logs in English      | Italian end users; code, documentation and logs are for developers and operators.                                                 |
| Index of all cards but the excluded ones                  | Product owner's choice: the chat is usable during the review; each source shows its review state; "approved only" filter.         |
| Chat in the web process, streamed (SSE)                   | Product owner's choice: answers appear while they are written; conversations are stored per user.                                 |
| Multilingual embeddings + hybrid search                   | Product owner's choice: cards are in English, questions may be in Italian; full-text finds exact names, codes and messages.       |
| Exact vector search, no ANN index                         | A project has hundreds to a few thousand chunks: a filtered sequential scan is fast and exact, and any dimension works.           |
| Test questions generated and manual, judged by the model  | Product owner's choice: retrieval measured (hit, rank, MRR), answers judged against the expected card.                            |
| undici `fetch` for model calls                            | Node's fetch gives up after 5 minutes without response headers; models on CPU can take longer to start answering.                 |
| New versions started manually, updated automatically      | Product owner's choice: "Nuova versione" acquires the code; the update of summaries and cards follows on its own.                 |
| Incremental update as an `understanding` job with a base  | Same phases as a full understanding: unchanged summaries and cards are copied, only what changed goes to the model.               |
| Incremental feature map                                   | Product owner's choice: features stay (with their cards, corrections and questions); new and changed files are assigned.          |
| Changed cards rewritten from the previous one             | Product owner's choice: reviewed cards return to `needs_recheck`; unchanged cards keep their review, verification, index.         |
| Version in use (`project.current_snapshot_id`)            | Chat, tests and review keep working on the previous version until the update is complete; then it is replaced.                    |
| Last N versions kept (`SNAPSHOT_RETENTION`)               | Product owner's choice: older versions are deleted when a new one becomes current; corrections and test questions stay.           |
| Export only, no import                                    | Product owner's choice: the knowledge goes to other systems (RAG pipelines, another Postgres), not to another instance.           |
| Export with embeddings, all cards or approved ones only   | Product owner's choice: the target can search at once (same embedding model); the scope is chosen at every export.                |
| SQL export with the same `rag` schema                     | Product owner's choice: the DDL is read from the database catalog, so it always matches the migrations; the script can be re-run. |
| Export as a direct, streamed download                     | Product owner's choice: no job and no file on the server; pages are read from one read-only transaction at the client's pace.     |

## Ready for durable workflows

Job phases follow the contract of Effect durable workflow activities: stable name, a single input (the job),
idempotency, output persisted before returning. A future migration will replace the pipeline engine
(`packages/core/src/pipeline.ts`) without rewriting the phases. See [Flows](flows.md#jobs-and-phases).
