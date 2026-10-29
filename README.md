# Code-to-RAG

A web application that starts from a project's source code (zip archive or Git repository), reconstructs its features
and produces **functional cards** for end users: what each feature does, how it is configured, parameters, limits,
validation rules, errors. Cards are verified automatically, reviewed by a person with AI assistance, and indexed in
a vector database that powers a RAG chatbot.

Commercially distributable product, installed **on premise** with Docker Compose.

> **Status:** all 7 phases completed (source acquisition, static analysis, AI understanding, review, RAG chat,
> incremental updates, knowledge export).
> See [Roadmap](#roadmap).

## Available features

- **Acquisition** from a zip archive (streamed upload) or a Git repository, including private ones with a read-only
  token (stored encrypted).
- **Safe extraction**: protection against path traversal, symbolic links and zip bombs; limits on size and number of
  files.
- Automatic **filters**: dependencies, build output, binaries, generated or minified files, lockfiles, sensitive
  files; every exclusion is recorded with its reason.
- **Credential masking** before anything is stored (cloud keys, tokens, passwords, private keys, connection
  strings…), keeping line numbers unchanged.
- **Background jobs** in a separate worker, with resumable phases, automatic retries and real-time progress (SSE).
- **Static analysis** with tree-sitter (TypeScript/JavaScript, Java, C#, Go, Python): declarations (classes,
  functions, methods, constants…) with lines, signature, documentation and visibility; imports resolved to files,
  packages/directories, namespaces or external libraries. It starts automatically after the acquisition and can be
  re-run.
- **AI understanding** (started on demand, "Genera schede"): bottom-up summaries (declarations → files → modules),
  feature map with the files and declarations involved, one **functional card** per feature written by reading all
  its files together. Every statement of a card cites the source lines it comes from; references are checked against
  the code shown to the model. Works with any OpenAI-compatible endpoint (Ollama, vLLM), never the Vercel AI
  Gateway. Summaries and cards are written in English and stored in a separate Postgres schema, `rag`.
- **Verification and review**: a decision model (`d1-omni` through Ollama) checks every card against the code in
  seconds (probability per statement, suspected missing rules); side-by-side card/code review page with approve, exclude, structured edit, assisted correction (the
  reviewer describes the mistake, the model rewrites the card) and regeneration. Corrections are kept and re-applied
  at every regeneration.
- **Embedding index** in pgvector: every card that is not excluded is split into chunks (overview and sections) and
  embedded with a multilingual model; the index follows regenerations, corrections and edits on its own.
- **RAG chat with citations**: hybrid search (vectors + PostgreSQL full-text, fused by rank) over the cards, answers
  streamed in the language of the question, citing the cards used (with their review state and a link to their
  review page); optionally only approved cards. Conversations are kept per user.
- **Test questions**: generated from the cards (with the expected answer) or written by reviewers, kept across
  regenerations; test runs measure whether the right card is found (hit rate, first place, MRR) and let the model
  judge each answer.
- **New versions of the code** ("Nuova versione": a new archive, or the latest commit of the branch): only what
  changed goes back to the model. Unchanged summaries and cards are reused with their review and index; the cards of
  changed files are updated from the previous ones (reviewed cards return "to be checked again"); new files are
  assigned to existing or new features. The previous version stays in use until the update is complete; the last
  versions are kept (`SNAPSHOT_RETENTION`), test runs of different versions can be compared, a version with no
  changes is not created.
- **Knowledge export** ("Esporta") of the version in use: a zip archive with `manifest.json` and one JSONL file per
  table, or a SQL script that creates the `rag` schema in another PostgreSQL (with pgvector) and replaces the
  project's data there. Cards, features, references, verifications, corrections, test questions and runs, summaries
  and the embedding index are included, every card except excluded ones or approved ones only; never the source code.
- **Project deletion**, with everything it produced (knowledge base, index, tests and conversations included).
- **Model call log**: phase, model, duration, tokens and outcome of every call, never the code.
- **Web interface**: login, project list, new project, job progress, file tree with exclusions, code viewer
  (Monaco) with file outline, dependencies and AI summary, symbol search, dependency overview, features and cards with
  clickable source references, model call statistics, light and dark theme.

## Quick start (Docker)

Requirements: Docker with the Compose plugin.

```bash
cp .env.example .env
# Set at least POSTGRES_PASSWORD, APP_ENCRYPTION_KEY and BETTER_AUTH_SECRET:
#   openssl rand -base64 32
docker compose up -d --build
```

Open http://localhost:3000: the first account created is the administrator. Further sign-ups are disabled unless
`AUTH_ALLOW_SIGNUP=true`.

AI understanding needs a model: set `AI_MODEL` (and `AI_BASE_URL` if the model is not served by the bundled Ollama).
The chat also needs an embedding model: `EMBEDDING_MODEL` (multilingual, e.g. `bge-m3`). The card verification needs
the decision model `d1-omni` (`DECISION_MODEL`; LFM Open License, see [Licenses](docs/licenses.md#decision-model)).
With the bundled Ollama:
`docker compose --profile ollama up -d`, then `docker compose exec ollama ollama pull <model>`.
See [Installation](docs/installation.md#ai-model).

## Local development

Requirements: Node.js 24, pnpm 10 (`corepack enable`), Docker (for PostgreSQL).

```bash
pnpm install
cp .env.example .env            # set the keys and the database URLs
docker compose up -d postgres   # PostgreSQL 17 + pgvector on localhost:5432
pnpm db:test:create             # once: database for the integration tests
pnpm db:migrate
pnpm dev                        # web on http://localhost:3000
pnpm dev:worker                 # worker (in another terminal)
```

### Main commands

| Command                     | Description                                                       |
| --------------------------- | ----------------------------------------------------------------- |
| `pnpm typecheck`            | Type checking of every package                                    |
| `pnpm lint` / `pnpm format` | ESLint / Prettier                                                 |
| `pnpm test:unit`            | Unit tests (no external services)                                 |
| `pnpm test:integration`     | Tests on PostgreSQL (`TEST_DATABASE_URL`, database name `*_test`) |
| `pnpm build`                | Web and worker bundles, with the third-party license inventory    |
| `pnpm licenses:check`       | License check of the distributed code (after `pnpm build`)        |
| `pnpm db:generate`          | New Drizzle migration after a schema change                       |
| `pnpm check`                | Typecheck, lint, formatting and tests in sequence                 |

## Structure

Hexagonal architecture (ports and adapters): `packages/core` holds the domain, the use cases and the ports and
depends on Effect only; inbound adapters call its inbound ports, outbound adapters implement its outbound ports
([details](docs/architecture.md#hexagonal-architecture)).

```
packages/
  core/         the hexagon: domain (entities, card schemas, filters, credential masking), application (use cases,
                pipelines, prompts), ports/inbound (Projects, Jobs, Analysis, Knowledge, Rag, Evaluation, Export),
                ports/outbound (repositories, models, source, analyzer, archive, secrets, job events)
adapters/
  inbound/
    web/        TanStack Start: pages, server functions, server routes (upload, SSE, chat, export, auth)
    worker/     job loop and migration command
  outbound/
    postgres/   Drizzle schema, migrations, repositories, LISTEN/NOTIFY, secret encryption
    openai/     chat and embedding models over the AI SDK (OpenAI-compatible endpoints: Ollama, vLLM…)
    ollama/     decision model over Ollama's System One API (card verification)
    filesystem/ uploads and work areas, zip extraction, Git clone, tree-sitter analysis, zip writing
docs/         architecture and flow documentation
```

## Documentation

- [Architecture](docs/architecture.md): components, packages, technologies, decisions
- [Flows](docs/flows.md): acquisition, static analysis, AI understanding, review, index, chat, test questions, new
  versions, jobs and phases, progress, authentication
- [Data model](docs/data-model.md): application tables and the `rag` schema
- [Security](docs/security.md): masking, extraction, tokens, web protections
- [Installation and configuration](docs/installation.md): Docker Compose, environment variables, operations
- [Licenses](docs/licenses.md): dependency policy and automated check

## Roadmap

1. **Foundations and acquisition** — completed
2. **Static analysis with tree-sitter**: symbols and dependencies between files — completed
3. **AI understanding**: summaries, feature map, card generation with line references — completed
4. **Automated verification and assisted review; project deletion** — completed
5. **Indexing in pgvector, RAG chat with citations, test questions** — completed
6. **Incremental updates on new versions of the code** — completed
7. **Per-project knowledge export** (JSONL archive with manifest, SQL script for another PostgreSQL) — completed

## Third-party licenses

The distributed images contain bundled code only; the licenses and NOTICE files of the included dependencies are in
`third-party-licenses/` inside each image. See [docs/licenses.md](docs/licenses.md).
