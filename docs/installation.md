# Installation and configuration

## Requirements

- Docker Engine with the Compose plugin (v2).
- Indicative resources: 2 CPUs, 4 GB of RAM, disk space for the database and the uploaded archives. Local models
  (Ollama) need additional resources, ideally a GPU: on CPU only, small models work but the understanding of a
  project takes hours.

## Start

```bash
cp .env.example .env
# set POSTGRES_PASSWORD, APP_ENCRYPTION_KEY, BETTER_AUTH_SECRET, PUBLIC_URL
docker compose up -d --build
```

Services:

| Service    | Role                                                           |
| ---------- | -------------------------------------------------------------- |
| `postgres` | PostgreSQL 17 + pgvector (data in the `postgres-data` volume)  |
| `migrate`  | Applies the migrations and exits                               |
| `web`      | Interface and API, port `WEB_PORT` (default 3000)              |
| `worker`   | Job execution                                                  |
| `ollama`   | Optional local models: `docker compose --profile ollama up -d` |

`web` and `worker` share the `app-data` volume mounted on `/data`.

To scale processing, start more workers: `docker compose up -d --scale worker=3`.

## Environment variables

| Variable                        | Default                 | Description                                                                            |
| ------------------------------- | ----------------------- | -------------------------------------------------------------------------------------- |
| `POSTGRES_USER` / `POSTGRES_DB` | `code_to_rag`           | User and database                                                                      |
| `POSTGRES_PASSWORD`             | —                       | Required                                                                               |
| `APP_ENCRYPTION_KEY`            | —                       | Required: 32 bytes, base64 (`openssl rand -base64 32`)                                 |
| `BETTER_AUTH_SECRET`            | —                       | Required: session secret                                                               |
| `PUBLIC_URL`                    | `http://localhost:3000` | Public URL of the application                                                          |
| `AUTH_ALLOW_SIGNUP`             | `false`                 | Open sign-up after the first account                                                   |
| `TRUST_PROXY`                   | `false`                 | `true` only behind a reverse proxy that rewrites `X-Forwarded-*`                       |
| `WEB_PORT`                      | `3000`                  | Port exposed by the web service                                                        |
| `ACQUISITION_MAX_ARCHIVE_MB`    | `200`                   | Maximum size of the uploaded zip                                                       |
| `ACQUISITION_MAX_TOTAL_MB`      | `1024`                  | Maximum size of the extracted or cloned code                                           |
| `ACQUISITION_MAX_FILE_MB`       | `1`                     | Above this size a file is excluded (`too_large`)                                       |
| `ACQUISITION_MAX_FILES`         | `50000`                 | Maximum number of files                                                                |
| `GIT_ALLOW_HTTP`                | `false`                 | Allows `http://` repositories (trusted internal networks only)                         |
| `GIT_CLONE_TIMEOUT`             | `10 minutes`            | Maximum clone time                                                                     |
| `WORKER_CONCURRENCY`            | `2`                     | Jobs run in parallel by each worker                                                    |
| `JOB_MAX_ATTEMPTS`              | `3`                     | Attempts per job                                                                       |
| `SNAPSHOT_RETENTION`            | `3`                     | Versions of the code kept per project, the one in use included (minimum 1)             |
| `LOG_FORMAT`                    | `json`                  | `json` or `pretty`                                                                     |
| `GRAMMARS_DIR`                  | set in the worker image | Directory of the tree-sitter `.wasm` files (development: resolved from `node_modules`) |

## AI model

The AI understanding ("Genera schede"), the test questions and the RAG chat call a chat model through an
OpenAI-compatible API: the bundled Ollama, an Ollama on the host, vLLM or any compatible server. The model must
support JSON-schema constrained output (`response_format`), as Ollama and vLLM do; otherwise set
`AI_STRUCTURED_OUTPUTS=false`. The chat runs in the **web** service, everything else in the worker: both receive the
`AI_*` and `EMBEDDING_*` variables.

| Variable                    | Default                  | Description                                                                 |
| --------------------------- | ------------------------ | --------------------------------------------------------------------------- |
| `AI_MODEL`                  | —                        | Model id; without it the understanding and the chat are disabled            |
| `AI_BASE_URL`               | `http://ollama:11434/v1` | Endpoint (`http://host.docker.internal:11434/v1` for an Ollama on the host) |
| `AI_PROVIDER_NAME`          | `ollama`                 | Name recorded in the call log                                               |
| `AI_API_KEY`                | —                        | Bearer key, if the endpoint requires one                                    |
| `AI_STRUCTURED_OUTPUTS`     | `true`                   | Send the JSON schema as `response_format`                                   |
| `AI_TIMEOUT`                | `5 minutes`              | Timeout of one call                                                         |
| `AI_MAX_RETRIES`            | `2`                      | Retries on transient errors (network, 408/429/5xx, timeout)                 |
| `AI_CONCURRENCY`            | `2`                      | Parallel calls per process (worker, web)                                    |
| `AI_CONTEXT_TOKENS`         | `16384`                  | Context window: prompts are sized to fit it                                 |
| `AI_MAX_OUTPUT_TOKENS`      | `4096`                   | Maximum answer length (structured answers)                                  |
| `AI_CHAT_MAX_OUTPUT_TOKENS` | `1024`                   | Maximum length of a chat answer                                             |
| `AI_TEMPERATURE`            | `0.1`                    | Sampling temperature                                                        |

There is no limit on how long the model takes to send its first token other than `AI_TIMEOUT`: model calls do not use
Node's built-in `fetch`, which gives up after 5 minutes without response headers.

### Decision model

The worker verifies the cards with a **decision model** through Ollama's System One API (`POST /v1/systemone`,
Ollama 0.35 or later): it answers yes/no questions with a probability and generates no text, so a card is verified in
seconds; the list of what a card is missing is still written by the chat model (`AI_MODEL`). Before the cards are
written it also tells user-level features from technical ones (bootstrap, build, tests, tooling), which get no card
unless a reviewer asks for one. It is **required**:
without the model the verification fails (`ollama pull d1-omni`). The default is
`d1-omni` by Liquid AI (600M parameters, about 850 MB; `d1`, 3B, is more accurate and slower). Both are released
under the **LFM Open License v1.0** (see [Licenses](licenses.md#decision-model)).

| Variable                       | Default               | Description                                                                      |
| ------------------------------ | --------------------- | -------------------------------------------------------------------------------- |
| `DECISION_MODEL`               | `d1-omni`             | Decision model (System One API)                                                  |
| `DECISION_BASE_URL`            | `http://ollama:11434` | Ollama server, without `/v1` (`http://host.docker.internal:11434` on host)       |
| `DECISION_TIMEOUT`             | `2 minutes`           | Timeout of one request                                                           |
| `DECISION_MAX_RETRIES`         | `2`                   | Retries of transient errors                                                      |
| `DECISION_CONCURRENCY`         | `1`                   | Requests in parallel per worker process                                          |
| `DECISION_CONTEXT_TOKENS`      | `12000`               | Budget of one request (Ollama's context, `OLLAMA_CONTEXT_LENGTH`, must cover it) |
| `DECISION_MAX_QUESTIONS`       | `64`                  | Questions per request (2–64)                                                     |
| `DECISION_KEEP_ALIVE`          | `10m`                 | How long Ollama keeps the model loaded                                           |
| `VERIFY_SUPPORTED_THRESHOLD`   | `0.7`                 | A statement at or above this probability is confirmed                            |
| `TRIAGE_USER_FACING_THRESHOLD` | `0.4`                 | Features below this probability of being user-facing get no card                 |
| `VERIFY_UNSUPPORTED_THRESHOLD` | `0.3`                 | Below this probability it is not confirmed (in between: partial)                 |

```bash
docker compose exec ollama ollama pull d1-omni
```

The thresholds are a starting point: compare the verdicts with the reviewers' decisions and adjust them. With a
small GPU, the chat model and the decision model may not fit in memory together: Ollama then swaps them, which costs a
few seconds at the start of `verify-cards`.

### Embeddings and chat

The chat searches the cards through embeddings stored in pgvector, computed by an embedding model behind an
OpenAI-compatible `/v1/embeddings` endpoint. Cards are in English and questions are usually in Italian: use a
**multilingual** model. The default suggestion is `bge-m3` (MIT, 1024 dimensions, available in Ollama). Any dimension
works; changing model re-indexes the cards (vectors of different models are never compared).

| Variable                  | Default       | Description                                                          |
| ------------------------- | ------------- | -------------------------------------------------------------------- |
| `EMBEDDING_MODEL`         | —             | Embedding model id; without it there is no index and no chat         |
| `EMBEDDING_BASE_URL`      | `AI_BASE_URL` | Embedding endpoint, if different from the chat one                   |
| `EMBEDDING_API_KEY`       | `AI_API_KEY`  | Bearer key of the embedding endpoint                                 |
| `EMBEDDING_BATCH_SIZE`    | `16`          | Texts per embedding request                                          |
| `RAG_TOP_CARDS`           | `5`           | Cards given to the chat model per question (fewer if they don't fit) |
| `RAG_CANDIDATES`          | `40`          | Chunks per search (vector, full-text) before the fusion              |
| `TEST_QUESTIONS_LANGUAGE` | `Italian`     | Language of the generated test questions                             |
| `TEST_QUESTIONS_PER_CARD` | `3`           | Questions generated per card                                         |

```bash
docker compose exec ollama ollama pull bge-m3
# .env: EMBEDDING_MODEL=bge-m3, then: docker compose up -d
```

After changing the embedding model's behaviour without changing its id (e.g. a different quantization), use
"Ricostruisci" in the index box of the project (Funzionalità tab).

With the bundled Ollama:

```bash
docker compose --profile ollama up -d
docker compose exec ollama ollama pull qwen3:4b-instruct   # or a larger model if you have a GPU
# .env: AI_MODEL=qwen3:4b-instruct, then: docker compose up -d
```

Indicative speed on CPU only (4 threads, `qwen3:4b-instruct`): about 1.5 output tokens per second with long prompts;
a card can take 20–30 minutes, so raise `AI_TIMEOUT` accordingly; a chat answer takes several minutes. With a GPU the
same calls take seconds. Chat answers and worker jobs share the model: on CPU a running understanding slows the chat
down.

Ollama's context window defaults to a few thousand tokens: the compose file sets `OLLAMA_CONTEXT_LENGTH` to
`AI_CONTEXT_TOKENS`. For an Ollama outside compose, set the same variable there (or create a model with
`PARAMETER num_ctx`). Check the license of the model you deploy: models are not part of the product.

An Ollama on the host listens on `127.0.0.1` by default: to reach it from the worker container
(`AI_BASE_URL=http://host.docker.internal:11434/v1`) it must listen on the Docker bridge too (`OLLAMA_HOST=0.0.0.0`,
protected by the host firewall).

## Reverse proxy

An HTTPS proxy (nginx, Traefik…) can sit in front of `web`. For the progress and chat streams (SSE) the proxy must
not buffer the responses of `/api/jobs/*/events` and `/api/chat` (the application already sends
`X-Accel-Buffering: no`), and its read timeout must cover a whole chat answer (minutes on CPU). The proxy's request
body limit must be at least `ACQUISITION_MAX_ARCHIVE_MB`.

## Backups

The database is enough: it holds projects, masked contents, jobs, users, the knowledge base with its index and the
chat conversations.

```bash
docker compose exec postgres pg_dump -U code_to_rag -Fc code_to_rag > backup.dump
```

Keep `APP_ENCRYPTION_KEY` separately: without it, the stored Git tokens can no longer be used.

Each project keeps up to `SNAPSHOT_RETENTION` versions of its code; unchanged files are stored once (deduplicated
by hash), so a new version mostly adds its changed files and the copies of the knowledge rows.

## Upgrades

```bash
docker compose build && docker compose up -d
```

The `migrate` service applies the new migrations before web and worker restart. Running jobs are returned to the
queue when the worker stops and resumed from the interrupted phase.

## Logs

Logs are JSON on standard output (`docker compose logs -f web worker`). They contain no project code, tokens or
secrets.
