# Installation and configuration

## Requirements

- Docker Engine with the Compose plugin (v2).
- Indicative resources: 2 CPUs, 4 GB of RAM, disk space for the database and the uploaded archives. Local models
  (Ollama, phase 3) need additional resources, ideally a GPU.

## Start

```bash
cp .env.example .env
# set POSTGRES_PASSWORD, APP_ENCRYPTION_KEY, BETTER_AUTH_SECRET, PUBLIC_URL
docker compose up -d --build
```

Services:

| Service    | Role                                                          |
| ---------- | ------------------------------------------------------------- |
| `postgres` | PostgreSQL 17 + pgvector (data in the `postgres-data` volume) |
| `migrate`  | Applies the migrations and exits                              |
| `web`      | Interface and API, port `WEB_PORT` (default 3000)             |
| `worker`   | Job execution                                                 |
| `ollama`   | Optional: `docker compose --profile ollama up -d`             |

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
| `LOG_FORMAT`                    | `json`                  | `json` or `pretty`                                                                     |
| `GRAMMARS_DIR`                  | set in the worker image | Directory of the tree-sitter `.wasm` files (development: resolved from `node_modules`) |

## Reverse proxy

An HTTPS proxy (nginx, Traefik…) can sit in front of `web`. For the progress stream (SSE) the proxy must not buffer
the responses of `/api/jobs/*/events` (the application already sends `X-Accel-Buffering: no`). The proxy's request
body limit must be at least `ACQUISITION_MAX_ARCHIVE_MB`.

## Backups

The database is enough: it holds projects, masked contents, jobs and users.

```bash
docker compose exec postgres pg_dump -U code_to_rag -Fc code_to_rag > backup.dump
```

Keep `APP_ENCRYPTION_KEY` separately: without it, the stored Git tokens can no longer be used.

## Upgrades

```bash
docker compose build && docker compose up -d
```

The `migrate` service applies the new migrations before web and worker restart. Running jobs are returned to the
queue when the worker stops and resumed from the interrupted phase.

## Logs

Logs are JSON on standard output (`docker compose logs -f web worker`). They contain no project code, tokens or
secrets.
