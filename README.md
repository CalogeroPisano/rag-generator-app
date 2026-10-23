# Code-to-RAG

A web application that starts from a project's source code (zip archive or Git repository), reconstructs its features
and produces **functional cards** for end users: what each feature does, how it is configured, parameters, limits,
validation rules, errors. Cards are verified automatically, reviewed by a person with AI assistance, and indexed in
a vector database that powers a RAG chatbot.

Commercially distributable product, installed **on premise** with Docker Compose.

> **Status:** phases 1–2 of 6 completed (source acquisition, static analysis). See [Roadmap](#roadmap).

## Available features (phases 1–2)

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
- **Web interface**: login, project list, new project, job progress, file tree with exclusions, code viewer
  (Monaco) with file outline and dependencies, symbol search, dependency overview, light and dark theme.

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

To include Ollama (local models, used from phase 3): `docker compose --profile ollama up -d`.

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

```
apps/
  web/        TanStack Start: pages, server functions, server routes (upload, SSE, authentication)
  worker/     job pipeline execution and migration command
packages/
  core/       domain (Effect): schemas, errors, configuration, ports, pipeline, use cases
  db/         Drizzle schema, migrations, repositories, LISTEN/NOTIFY listener
  analysis/   acquisition (zip, Git, filters, languages, credential masking) and tree-sitter parsing
  ai/         AI layer (phase 3)
docs/         architecture and flow documentation
```

## Documentation

- [Architecture](docs/architecture.md): components, packages, technologies, decisions
- [Flows](docs/flows.md): acquisition, static analysis, jobs and phases, real-time progress, authentication
- [Data model](docs/data-model.md): tables and relationships
- [Security](docs/security.md): masking, extraction, tokens, web protections
- [Installation and configuration](docs/installation.md): Docker Compose, environment variables, operations
- [Licenses](docs/licenses.md): dependency policy and automated check

## Roadmap

1. **Foundations and acquisition** — completed
2. **Static analysis with tree-sitter**: symbols and dependencies between files — completed
3. AI understanding: summaries, feature map, card generation with line references
4. Automated verification and assisted review
5. Indexing in pgvector, RAG chat with citations, test questions
6. Incremental updates on new versions of the code

## Third-party licenses

The distributed images contain bundled code only; the licenses and NOTICE files of the included dependencies are in
`third-party-licenses/` inside each image. See [docs/licenses.md](docs/licenses.md).
