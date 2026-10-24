# Flows

## Creating a project from a zip archive

Upload happens in two steps: first the archive (raw request body, streamed), then the project creation with the
upload id.

```mermaid
sequenceDiagram
  actor U as User
  participant B as Browser
  participant W as web
  participant FS as /data/uploads
  participant DB as PostgreSQL

  U->>B: picks the .zip file
  B->>W: POST /api/uploads (body = file, with progress)
  W->>W: session and CSRF checks
  W->>FS: streams <id>.zip.part,<br/>aborts beyond the limit
  W->>W: checks the zip signature
  W->>FS: renames to <id>.zip
  W-->>B: 201 { uploadId }
  B->>W: server function createProject({ name, zip, uploadId })
  W->>FS: checks that the upload exists
  W->>DB: transaction: project + snapshot (pending)<br/>+ job (queued) + "queued" event + NOTIFY
  W-->>B: project summary
  B->>B: opens the project page and the SSE stream
```

An upload never attached to a project is deleted by the worker after 24 hours.

## Creating a project from a Git repository

```mermaid
sequenceDiagram
  actor U as User
  participant B as Browser
  participant W as web
  participant DB as PostgreSQL

  U->>B: URL, branch, user and token (optional)
  B->>W: server function createProject({ name, git })
  W->>W: validates the URL (https only, no credentials in the URL)
  W->>W: encrypts the token (AES-256-GCM, bound to the project id)
  W->>DB: transaction: project (encrypted token) + snapshot + job + event
  W-->>B: project summary
```

The token is never returned to the client: the interface only knows whether the project has credentials.

## Jobs and phases

### Job lifecycle

```mermaid
stateDiagram-v2
  [*] --> queued: created
  queued --> running: claim (FOR UPDATE SKIP LOCKED)
  running --> succeeded: all phases completed
  running --> queued: transient error<br/>(retry with backoff)
  running --> failed: permanent error<br/>or attempts exhausted
  running --> queued: worker stopped (release)<br/>or no heartbeat (requeue)
  failed --> queued: manual retry<br/>(resumes from the failed phase)
  succeeded --> [*]
```

- **Claim**: each worker takes the oldest runnable job with `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED
LIMIT 1)`. Two workers never take the same job. The claim increments the attempt count.
- **Heartbeat**: every 15 seconds the worker updates `heartbeat_at`. A `running` job with no heartbeat for more than
  2 minutes is put back in the queue (or marked failed when it has no attempts left).
- **Errors**: each phase reports whether an error is recoverable. Corrupted archives, exceeded limits, rejected
  credentials or missing repositories fail immediately; network, database or filesystem errors are retried with
  growing delays (30 s, 60 s, 120 s… up to 15 minutes) within `JOB_MAX_ATTEMPTS`.
- **Worker shutdown**: interruption returns the job to the queue without consuming the attempt.

### Acquisition phases

Every phase is **idempotent**: it can run again and produces the same result, because it clears or overwrites
whatever a previous attempt left behind. Completed phases are recorded in `job.completed_phases`; a resumed job runs
only the missing ones.

```mermaid
flowchart LR
  fetch["fetch<br/>source acquisition"] --> ingest["ingest<br/>filtering and masking"] --> finalize["finalize<br/>completion"]
```

| Phase      | What it does                                                                                                                                                                                                                                                                                                         |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fetch`    | Sets the snapshot to `acquiring` and recreates the work area `/data/work/<jobId>/src`. Zip: safe extraction and recording of the skipped entries (links, encrypted entries, oversized files). Git: decrypts the token, clones the requested branch (depth 1) and stores the commit.                                  |
| `ingest`   | Re-runs `fetch` if the work area is missing (e.g. container restart). Deletes the files already stored for the snapshot, walks the tree in deterministic order, classifies, decodes (UTF-8 or Windows-1252), masks credentials and stores in batches of 200 files with progress. Computes the content hash for zips. |
| `finalize` | Snapshot `ready`, deletion of the work area and of the uploaded zip, then the static analysis is queued.                                                                                                                                                                                                             |

On a permanent failure the snapshot becomes `failed` and the work area is removed; the uploaded zip is kept so the
job can be retried manually.

### Processing a file

```mermaid
flowchart TD
  start([file]) --> path{"classification<br/>by path"}
  path -- "lockfile, minified, source map,<br/>generated, binary, sensitive" --> excl([excluded with reason])
  path -- ok --> size{"larger than the<br/>per-file limit?"}
  size -- yes --> excl
  size -- no --> content{"classification<br/>by content"}
  content -- "NUL bytes, generated-code markers,<br/>minified lines" --> excl
  content -- ok --> decode["decoding<br/>UTF-8 / Windows-1252"]
  decode --> mask["credential masking<br/>(lines unchanged)"]
  mask --> store([stored: masked content,<br/>hash, language, findings])
```

Dependency, build, version-control and tooling directories (`node_modules`, `dist`, `.git`, `.idea`…) are not walked:
they are recorded as a single excluded entry.

## Static analysis

An `analysis` job, separate from the acquisition, extracts declarations and imports from the masked contents stored
in PostgreSQL: it needs no work area and never reads the original code. It is queued by `requestAnalysis` at the
end of the acquisition and by the "Rianalizza" action; if one is already queued or running for the same snapshot,
that job is returned instead of creating a new one (advisory lock).

```mermaid
flowchart LR
  parse["parse<br/>symbols and imports"] --> resolve["resolve<br/>import targets"] --> finalize["finalize<br/>totals, status ready"]
```

| Phase      | What it does                                                                                                                                                                                                                                                                              |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parse`    | Sets `analysis_status = running`, deletes the symbols and dependencies of a previous attempt, then parses the files of the supported languages in batches of 100 with tree-sitter (WebAssembly). Stores symbols, imports (target `pending`), Java/Go package and number of syntax errors. |
| `resolve`  | Loads paths, packages and configuration files (`tsconfig*.json`, `jsconfig.json`, `package.json`, `go.mod`) of the snapshot and resolves pending imports in batches of 1000.                                                                                                              |
| `finalize` | Computes `symbol_count` and `dependency_count`, records `analyzer_version` and `analyzed_at`, sets `analysis_status = ready`.                                                                                                                                                             |

A permanent failure sets `analysis_status = failed`; the acquired snapshot stays usable.

### Extraction

For each language a tree-sitter query (`packages/analysis/src/parsing/queries.ts`) captures declarations and
imports; `extract.ts` turns the captures into symbols:

- kinds: namespace, module, class, interface, enum, struct, record, type, function, method, constructor, property,
  field, constant, variable; only top-level variables and constants are kept, not local ones;
- `qualifiedName` from the enclosing declarations (Go methods are attached to their receiver type);
- `exported` according to the language: ES `export`, `public` in Java/C#, capitalised names in Go, names without a
  leading underscore in Python;
- `signature` (declaration header without the body) and `doc` (preceding comments, Python docstring);
- syntax errors are counted, not fatal: tree-sitter recovers and the rest of the file is analyzed.
  Known gap: the TypeScript grammar (0.23.2, the latest release) does not support variance annotations
  (`<in T>`, `<out T>`); such files report errors but their declarations are still extracted.

### Import resolution

Targets keep the granularity of the language (no invented file-level edges):

| Language | Resolution                                                                                                                                                                                          |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TS / JS  | Relative paths with extension and `index` probing (`.js` → `.ts` too), `paths`/`baseUrl` of the nearest tsconfig/jsconfig, workspace packages by `package.json` name; bare specifiers → `external`. |
| Java     | Fully qualified classes → `file` through the declared packages; `pkg.*` → `directory`; static imports → the class file; unknown → `external`.                                                       |
| C#       | `using` → `namespace` when declared in the project, otherwise `external`.                                                                                                                           |
| Go       | Module path from `go.mod` → package `directory`; other paths → `external`.                                                                                                                          |
| Python   | Relative imports from the file's package; absolute imports from the project roots (`module.py`, `module/__init__.py`); otherwise `external`.                                                        |

## AI understanding

Started manually from the project page ("Genera schede", available when the static analysis is ready and `AI_MODEL`
is set): `requestUnderstanding` queues an `understanding` job (or returns the one already queued or running). It reads
only masked contents and the static analysis, and writes only to the `rag` schema.

```mermaid
flowchart LR
  prepare["prepare<br/>reset rag data"] --> files["summarize-files<br/>declarations + file"]
  files --> modules["summarize-modules<br/>bottom-up"] --> map["map-features<br/>features + files"]
  map --> cards["generate-cards<br/>one per feature"] --> verify["verify-cards<br/>second reading"]
  verify --> finalize["finalize<br/>counts, ready"]
```

| Phase               | What it does                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prepare`           | Fails at once (not retried) if no model is configured. Sets `understanding_status = running`, deletes the snapshot's `rag` data and records its identity in `rag.snapshot` (project, revision, model, language).                                                                                                                                                                                                              |
| `summarize-files`   | Application code (the analyzed languages, without tests) and configuration files (`application*.properties`, `appsettings*.json`, `config/*`…). One call per file with numbered lines and its declarations: file summary plus a sentence per relevant declaration. Files larger than the context are split at declaration boundaries and summarized in parts, then rolled up. Resumable: stored summaries are not recomputed. |
| `summarize-modules` | Directories bottom-up, from the summaries of their files and sub-modules; pass-through directories (one child, no files) are skipped. The root module is the project overview.                                                                                                                                                                                                                                                |
| `map-features`      | The model lists the user-level features with their files and declarations, from the module overview and one line per file. Large projects are mapped in batches, then the candidates are merged. Paths and declarations that do not exist are dropped.                                                                                                                                                                        |
| `generate-cards`    | For each feature, the files are read together: whole when they fit, otherwise the declarations of the feature with some context, then the first lines of the other files, then summaries only. The card cites path and lines for every statement; references outside the lines shown are dropped and statements left without one are counted. Resumable per card.                                                             |
| `verify-cards`      | Second reading of every card against its code (see [Review](#automatic-verification)). Resumable: cards whose current version is verified are skipped.                                                                                                                                                                                                                                                                        |
| `finalize`          | Counts features and cards, `understanding_status = ready`.                                                                                                                                                                                                                                                                                                                                                                    |

- **Streaming**: answers are always streamed and parsed at the end. A non-streamed call to a slow local model would
  hit the 5-minute limit Node's `fetch` puts on waiting for response headers; with streaming only `AI_TIMEOUT` applies.
- **Budget**: every prompt is sized from `AI_CONTEXT_TOKENS - AI_MAX_OUTPUT_TOKENS` (conservative estimate of 3
  characters per token).
- **Invalid answers**: the answer is validated with the Effect schema of the prompt; if it does not match, the model
  gets its answer back with the validation problems once; a second invalid answer skips that file, module or card
  (counted in the progress message) instead of failing the job.
- **Transient errors** (network, 408/429/5xx, timeout) are retried by the AI layer (`AI_MAX_RETRIES`, exponential
  backoff), then by the job runner from the failed phase; configuration errors (missing model, 4xx) fail at once.
- **Prompts are versioned** (`packages/ai/src/prompts/*`): the version is stored with every result and in the call
  log. Changing a prompt means bumping its version.
- Requesting the understanding again starts from scratch for that snapshot (phase 6 will reuse unchanged summaries,
  keyed by content hash). Reviewer corrections are kept: after the new feature map they are re-attached to the feature
  with the same name and applied to its new card (see [Review](#review)).
- Understanding and card jobs exclude each other on a project: a new feature map would replace the cards being
  reviewed.

## Review

### Automatic verification

`verify-cards` (last phase of the understanding) and the "Verifica" action on a card run the `card-verify` prompt:
the model reads the card next to the code of its feature (the cited lines are always included) and returns a verdict
per statement (`supported`, `partial`, `unsupported`, with a short note) plus what the code shows and the card
misses (validation rules, limits, errors, settings). Statements are identified as `section.index`; statements the
verifier leaves out count as not assessed. The result is stored per card version in `rag.card_verification`:

- `issues` = statements not fully supported + missing items + statements without references;
- a card still `generated` or `flagged` becomes `flagged` when issues were found, `generated` otherwise; review
  decisions (`in_review`, `approved`, `excluded`) are not touched;
- a verification of an older version is shown as outdated; the next understanding run verifies the card again.

### Card states

```mermaid
stateDiagram-v2
  [*] --> generated: card written
  generated --> flagged: verification finds issues
  flagged --> generated: verification passes
  generated --> in_review: manual edit / assisted correction
  flagged --> in_review: manual edit / assisted correction
  generated --> approved
  flagged --> approved
  in_review --> approved
  generated --> excluded
  flagged --> excluded
  in_review --> excluded
  approved --> in_review: reopened
  excluded --> in_review: reopened
  in_review --> generated: regenerated
```

`needs_recheck` is reserved for incremental updates (phase 6).

### Operations

The review page (`/projects/<id>/cards/<featureId>`) shows the card next to the code: the files of the feature as
tabs, every cited range marked, the selected statement in focus.

| Action              | How it runs                                                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Approve / Exclude   | Immediate; the reviewer's name and time are stored on the card. Reopening puts it back `in_review`.                                                                                                           |
| Edit                | Structured form (every section, item and reference). References must point to existing lines of the snapshot's files, the others are dropped. New version, `in_review`; the verification becomes outdated.    |
| Assisted correction | The reviewer describes the mistake. The text is stored in `rag.correction`, then a `card` job asks the model to update the current card checking the code again; the new version is `in_review` and verified. |
| Verify              | `card` job: verification of the current version.                                                                                                                                                              |
| Regenerate          | `card` job: the card is written from scratch with all the feature's corrections, then verified (`generated`/`flagged`). Manual edits are lost; corrections are not.                                           |

Card jobs carry `{ cardId, featureId, operation }` in `job.payload`; there is at most one active job per card
(`dedupe_key` = feature id). They look the card up by feature, since regeneration replaces the card row.

### Corrections across regenerations

Corrections belong to the project and to a feature **name** (`feature_key`: lower case, punctuation and spacing
ignored), not to a card. Every card written for that feature (understanding, regeneration, correction) gets them in
its prompt, oldest first, and records the version that applied them. After a new feature map they are re-attached by
name; those whose feature disappeared are listed as orphans in the features tab.

## Deleting a project

"Elimina progetto" on the project page, confirmed by typing the project name. Refused while a job of the project is
running (queued jobs are deleted with it). In order: the project's knowledge in the `rag` schema (snapshots,
summaries, features, cards, verifications, corrections; deleted explicitly since `rag` has no foreign keys), then the
project with its snapshots, files, symbols, jobs and events (cascade), the masked blobs no other project uses, and the
uploaded archives on disk. The model call log is kept (its references become null).

## Real-time progress

```mermaid
sequenceDiagram
  participant B as Browser (EventSource)
  participant W as web
  participant L as JobEventsListener
  participant DB as PostgreSQL
  participant K as worker

  B->>W: GET /api/jobs/<id>/events (Last-Event-ID)
  W->>DB: events after the last id
  W-->>B: event: job-event (with id) … + event: job (state)
  K->>DB: transaction: updates job + inserts event + pg_notify
  DB-->>L: NOTIFY job_events <jobId>
  L-->>W: wakes up the stream of that job
  W->>DB: new events
  W-->>B: event: job-event … + event: job
  Note over W,B: without notifications, checks every 5 s
  W-->>B: closes the stream when the job is finished
```

- A single connection per web process runs `LISTEN job_events` and fans notifications out to the clients. If the
  connection drops it is re-established; in the meantime streams re-check the database every 5 seconds.
- Each event has a sequential id: a reconnecting `EventSource` resumes from `Last-Event-ID` without losing or
  duplicating events.
- The browser closes the stream when the job is finished; after a manual retry it opens a new one.

## Authentication

```mermaid
sequenceDiagram
  actor U as User
  participant B as Browser
  participant W as web
  participant A as Better Auth
  participant DB as PostgreSQL

  U->>B: opens a protected page
  B->>W: beforeLoad → getSession
  W->>A: session from the cookie
  A->>DB: session lookup
  alt no session
    W-->>B: redirect /login?redirect=…
    U->>B: email and password
    B->>W: POST /api/auth/sign-in/email
    W->>A: verifies the credentials
    A-->>B: session cookie (HttpOnly, SameSite=Lax)
  end
  B->>W: server function (cookie)
  W->>W: authMiddleware: valid session?
```

- On a fresh installation the login page offers to create the first account (administrator). After that, sign-up
  is only allowed with `AUTH_ALLOW_SIGNUP=true`.
- The check in the routes (`beforeLoad`) is for the user experience; data protection lives in `authMiddleware`,
  applied to every server function, and in the session checks of the server routes.

## Periodic maintenance (worker)

Every minute the worker:

1. puts back in the queue the jobs without a heartbeat (or marks them failed when they have no attempts left);
2. deletes zips uploaded more than 24 hours ago that are not attached to a snapshot still to be acquired.
