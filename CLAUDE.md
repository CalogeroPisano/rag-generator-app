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
pnpm db:generate              # new Drizzle migration after editing packages/db/src/schema
docker compose up -d --build  # full stack (web, worker, migrate, postgres); --profile ollama for Ollama
```

Human-facing documentation lives in `README.md` and `docs/` (architecture, flows, data model, security,
installation, licenses): **update it together with the code at every phase.**

Copy `.env.example` to `.env` first (`openssl rand -base64 32` for `APP_ENCRYPTION_KEY` and `BETTER_AUTH_SECRET`).

## Architecture

```
apps/web        TanStack Start 1.x: routes, server functions, server routes (upload, SSE, auth)
apps/worker     job worker (separate process) + migrate command
packages/core   domain (Effect): schemas, errors, config, ports (repository interfaces), pipeline, use cases
packages/db     Drizzle schema + migrations, repository implementations (Layers), LISTEN/NOTIFY listener
packages/analysis  acquisition primitives (safe zip extraction, git clone, filters, languages, secret masking) and
                   static analysis (src/parsing: tree-sitter grammars, queries, extraction, import resolution)
packages/ai     AI layer (phase 3; placeholder)
```

Dependency direction: `analysis` ← `core` ← `db` ← apps. `core` defines the repository **ports**
(`ProjectRepository`, `SnapshotRepository`, `JobRepository`, `AnalysisRepository` in `core/src/ports.ts`); `db` implements them. Never
import `db` from `core`.

### Data flow (phase 1)

1. Zip: browser streams the raw file to `POST /api/uploads` → `receiveUpload` writes `DATA_DIR/uploads/<id>.zip`
   (size enforced while streaming). Git: URL + optional read-only token.
2. `createProjectFn` (server function) → `createProject`: token sealed with `SecretBox` (AES-256-GCM, AAD = project
   id), project + snapshot + job inserted in one transaction.
3. Worker claims the job (`FOR UPDATE SKIP LOCKED`) and runs `acquisitionPipeline`: `fetch` (extract/clone into
   `DATA_DIR/work/<jobId>`), `ingest` (walk, classify, decode, **mask secrets**, store), `finalize` (snapshot ready,
   temp data deleted).
4. Every job transition appends a `job_event` and `pg_notify('job_events', jobId)`; `GET /api/jobs/$jobId/events`
   (SSE) streams events, woken by `JobEventsListener` (LISTEN) with a 5 s polling fallback.

### Data flow (phase 2: static analysis)

1. `finalize` of the acquisition (and the "Rianalizza" action) calls `requestAnalysis`: queues an `analysis` job
   (`JobRepository.enqueue` returns the job already queued/running for the snapshot, under an advisory lock).
2. `analysisPipeline` (`core/src/analysis.ts`): `parse` (clears previous output, parses masked contents from
   Postgres in batches with `CodeAnalyzer` → `symbol` + `file_dependency` rows with target `pending`), `resolve`
   (`makeResolver` over paths, packages, tsconfig/jsconfig/package.json/go.mod → target kind
   `file|directory|namespace|external|unresolved`), `finalize` (counts, `analyzer_version`, status `ready`).
3. web-tree-sitter runs the grammars as WASM: `GRAMMARS_DIR` in the worker image (`dist/grammars`, copied by
   `scripts/vite-plugin-grammars.mjs`), otherwise resolved from `node_modules`. Bump `ANALYZER_VERSION`
   (`analysis/src/parsing/model.ts`) when extraction or resolution rules change.

### Jobs and phases

- A phase has a stable `name`, takes only the job, is **idempotent** (clears/overwrites what a previous attempt
  produced) and persists its output before returning. This is the contract that lets phases become activities of
  Effect durable workflows later.
- The runner (`core/src/pipeline.ts`) records `completed_phases`; a failed job resumes from the failed phase.
  `PhaseError.retryable` decides between automatic retry (exponential backoff, `max_attempts`) and immediate failure.
- Worker heartbeat every 15 s; `requeueStale` re-queues jobs of dead workers (or fails them when out of attempts).
  SIGTERM interrupts the worker: running jobs are released without consuming an attempt.

### Security rules

- Source code content is stored **only after masking** (`analysis/src/secrets.ts`); unmasked originals are never
  persisted (temp area is deleted) and must never be logged or sent to a model. Masking preserves line numbers.
  Unquoted `key = value` masking is limited to configuration-like languages (`configLanguages`): in code it would
  mask expressions (`password: z.string()`) and break parsing.
- Findings record rule + line only, never the secret.
- Git tokens: encrypted at rest, passed to isomorphic-git only via `onAuth`, never in URLs, logs or errors.
- Zip: paths sanitised (`sanitizeArchivePath` + `resolveInside`), symlinks never materialised, sizes enforced on
  inflated bytes (headers are not trusted).
- Every server function touching data uses `authMiddleware`; server routes check the session themselves.
- Errors crossing to the client go through `runEffect` (`apps/web/src/server/run.server.ts`): only tagged,
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
  (`apps/web/src/server/runtime.server.ts`).
- DB rows are validated with the domain schemas when they leave the database (`packages/db/src/rows.ts`).
- Server functions: `createServerFn().middleware([authMiddleware]).validator(Schema.toStandardSchemaV1(...))`;
  results are encoded to plain objects (`Schema.encodeSync`) before crossing the network.
- Files named `*.server.ts` are server-only; `*.client.ts(x)` are browser-only (Monaco).
- UI: shadcn/ui components live in `apps/web/src/components/ui` (added with the shadcn CLI, customised there:
  e.g. Badge `success|warning|info` variants, theme tokens `--success/--warning/--info` in `styles.css`). No other
  component libraries. Light/dark via `next-themes`. UI text is Italian; code comments, documentation, commit messages and logs are English.
- Monaco is bundled locally (no CDN), core + Monarch highlighting only (`components/code/monaco.client.ts`).
- Formatting: Prettier (120 cols, no semicolons, double quotes). Exact dependency versions only.
- No `console.*` in application code (use Effect's logger); scripts may use the console.

## Licensing

Policy: MIT, Apache-2.0, BSD-2/3-Clause, ISC, PostgreSQL only. Builds bundle everything (images contain no
`node_modules`); `scripts/vite-plugin-third-party.mjs` records each bundled package and copies its
LICENSE/NOTICE files into `dist/third-party-licenses/`, which ship in the images. `scripts/check-licenses.mjs`
fails on anything outside the policy unless approved in `licenses.exceptions.json` (exact SPDX expression,
reason, approver). Approved so far: `tslib` (0BSD), `isbot` (Unlicense), `pako` (MIT AND Zlib). Build-only
tools (lightningcss MPL-2.0, caniuse-lite CC-BY-4.0, argparse Python-2.0) are not distributed. Check the license
of every new dependency before adding it.

## Decisions (beyond the spec)

- Database access: Drizzle ORM + `pg` (user's choice: `@effect/sql-pg` is unstable in Effect 4.0.5).
- Authentication: Better Auth (email/password), sharing the app's pg pool; telemetry disabled. The first account
  can always sign up (bootstrap); later sign-ups only with `AUTH_ALLOW_SIGNUP=true`. Roles: not yet.
- Masked file contents stored in Postgres (`source_blob`, deduplicated by hash); nothing on disk after acquisition.
- Git via isomorphic-git (pure JS; no git binary in the images).
- Web production server: srvx (bundled `serve.js`); Nitro 3 is still beta.
- TypeScript 6.0.x (typescript-eslint does not support 6.1+ / 7 yet).

## Status

- Phase 1 (foundations and acquisition): implemented.
- Phase 2 (static analysis with tree-sitter: TS/JS, Java, C#, Go, Python): implemented.
- Next: phase 3 (AI: summaries, feature map, cards).
