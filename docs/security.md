# Security

## Source code of the analyzed projects

**Rule:** original code is never stored nor sent to a model. Only the masked text is stored.

- Credentials are masked (`packages/analysis/src/secrets.ts`) before anything is stored. Each credential found is
  replaced with `[REDACTED:<rule>]`, keeping the line breaks, so line numbers stay those of the original (card
  references depend on them).
- Rules: AWS keys, GitHub, GitLab, Slack and npm tokens, Stripe, Google, SendGrid and Azure Storage keys,
  OpenAI/Anthropic-style keys, JWTs, `Authorization` headers, credentials in connection strings, PEM private keys,
  and values assigned to sensitive keys (`password`, `secret`, `token`, `api_key`…). For the latter, messages,
  references to environment variables and low-entropy values are ignored, so validation messages stay readable.
  Keys that name a password (`password`, `passwd`, `pwd`, `passphrase`) are stricter: any literal without spaces is
  masked, however short or simple (`password: 'test'`), since weak and test passwords are real credentials too.
  Projects acquired before this rule keep their stored contents: acquire them again (new project) to apply it.
  Unquoted values are masked only in configuration-like files (`.env`, properties/ini, YAML, TOML, shell…): in source
  code they are expressions (`password: z.string()`, `password = request.form["password"]`), and masking them
  would hide code without protecting anything.
- For each credential only the rule and the line are recorded, never the value.
- Sensitive files (`.env`, `*.pem` and `*.key` keys, keystores…) are excluded entirely; templates (`.env.example`)
  are read and masked.
- The work area with the original code exists only while the job runs and is deleted at the end (also on a permanent
  failure).

Static analysis (tree-sitter) reads only the masked contents from the database: symbols, signatures and doc
comments are therefore extracted from already-masked text. Parsing logs record counts only, never code.

## Calls to models

- Only masked contents leave the database: the understanding reads `source_blob` (masked at ingestion), never the
  original files. Prompts tell the model never to reproduce `[REDACTED:…]` values.
- Calls go only to the configured OpenAI-compatible endpoint (`AI_BASE_URL`), typically on the same network (Ollama,
  vLLM). The Vercel AI Gateway is never used: the provider is always created explicitly (its package is bundled
  because the `ai` package depends on it, but no model is ever resolved through it).
- Every call is logged in `model_call` with metadata only (phase, model, duration, tokens, outcome). Error details are
  reduced to the error name and HTTP status, since provider messages can echo the prompt. Application logs never
  contain prompts or answers.
- `AI_API_KEY` is read as a redacted value and is never logged; the web app only exposes whether a model is
  configured and its name.
- Model output is untrusted: it is validated against the schema, and file paths, declarations and line references
  are checked against the snapshot; anything else is dropped.
- The **RAG chat** sends the embedding endpoint the user's question and the chat model the question, the last
  exchanges of the conversation and the text of the retrieved cards (no source code, no references). The index
  (`rag.chunk`) stores card text only. Chat answers are rendered as plain text (no HTML or Markdown), and citation
  numbers outside the sources are ignored.
- Questions and answers of the chat are product data: they are stored in `chat_message` (as the cards are stored in
  `rag`), never in `model_call` or in the logs.
- `EMBEDDING_API_KEY` is redacted like `AI_API_KEY`; the web app only exposes the names of the configured models.

## Knowledge export

- Any authenticated user can export a project (there are no roles yet); the download route checks the session.
- The export contains the `rag` data of the version in use: summaries, cards (with paths and line numbers of their
  references), verifications, the embedding index, corrections and test questions with the **names of their authors**
  (and the reviewer of each card), test runs with the chat answers. It never contains source code, masked or not.
- The SQL script is built from values, never from SQL text found in the data: identifiers are quoted, strings are
  literals for `standard_conforming_strings = on` (set by the script itself), numbers and vectors are checked to be
  finite numbers, and the project name and revision in the header comments lose their line breaks and control
  characters (they would otherwise end the comment and become SQL).
- Running the script needs the right to create the `vector` extension and the `rag` schema in the target database;
  it deletes the target's rows of the same project id before inserting (other projects are not touched).
- Files are streamed: nothing is written on the server's disk. The export reads from a read-only transaction.

## Deletion

Deleting a project removes its masked code, analysis, knowledge (`rag` schema: corrections, embedding index, test
questions and runs included), chat conversations, jobs and uploaded archives; blobs shared with other projects are kept. Only the model call log remains, without content.

## Zip archives

- Entry names are normalized (`sanitizeArchivePath`); absolute paths, drive letters, `..` segments and NUL
  characters are rejected, and the destination is checked again (`resolveInside`).
- Symbolic links are never created; encrypted entries or entries with unsupported compression are excluded.
- Limits apply to the bytes actually decompressed, not to the sizes declared in the archive (zip bomb protection):
  archive size, total size, number of files, size per file.
- The tree scan does not follow symbolic links.

## Git repositories

- `https` URLs only (`http` if enabled with `GIT_ALLOW_HTTP`); credentials in the URL are rejected.
- The token is encrypted at rest (AES-256-GCM, key `APP_ENCRYPTION_KEY`, associated data = project id) and handed to
  isomorphic-git only through the authentication callback: it never appears in URLs, git configuration, logs or
  error messages.
- Depth-1 clone of a single branch, without tags, with a timeout.

## Web application

- **Authentication**: Better Auth with email and password (at least 12 characters), `HttpOnly` and `SameSite=Lax`
  session cookies. Telemetry disabled.
- **Authorization**: every server function that reads or writes data uses `authMiddleware`; server routes check the
  session. Checks in the pages only serve the user experience.
- **CSRF**: server functions, the zip upload and the chat stream (`POST /api/chat`) only accept same-origin requests.
- **Chat conversations** are private: every read, write and deletion is filtered by the session user; a conversation
  id of another user answers "not found".
- **Errors**: only messages meant for the user reach the client; technical details stay in the logs.
- **Headers**: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`.
- **Redirect after login**: internal paths only.
- **Monaco** is served by the application, with no external CDN.

## Configuration secrets

| Variable             | Use                                         |
| -------------------- | ------------------------------------------- |
| `APP_ENCRYPTION_KEY` | Encryption of Git tokens (32 bytes, base64) |
| `BETTER_AUTH_SECRET` | Session signing                             |
| `POSTGRES_PASSWORD`  | Database access                             |

They never go in the code or the logs; `.env` is excluded from version control. Changing `APP_ENCRYPTION_KEY` makes
the stored tokens unreadable.

## Containers

- Images run as the unprivileged `node` user and contain JavaScript bundles only (no `node_modules`, no git
  binary).
- PostgreSQL is exposed on `127.0.0.1` only.

Old versions of the code are deleted the same way (files, analysis, knowledge, index, test runs, archives) when a
newer version becomes current and they exceed `SNAPSHOT_RETENTION`; corrections, test questions and conversations
belong to the project and stay until it is deleted.

## Known limitations

- Masking is rule-based: credentials in unrecognized formats can slip through. Rules must be extended when new
  formats emerge.
- isomorphic-git keeps the repository pack in memory during the clone; when the timeout expires the job fails but the
  clone is not stopped immediately.
- There are no roles yet: every authenticated user sees every project (and can chat about it; conversations stay
  private).
- An incremental update trusts unchanged files: a card whose files did not change is copied with its review, even if
  code elsewhere (a shared helper outside the feature's files) changed its behaviour. "Rigenera schede" rebuilds
  everything from scratch.
- Chat answers come from a model: they can be wrong or incomplete even when they cite the right card. Each source
  shows its review state; "Solo schede approvate" restricts the chat to reviewed cards.
- Cards are generated by a model and can be wrong even when their references are valid: the automatic verification is
  itself done by a model. Only approval by a reviewer makes a card trusted.
  In the end-to-end test with a small model on CPU (`qwen3:4b-instruct`, `expressjs/cors`) most references were
  exact, some pointed a few lines off and one default value was missing: verification (phase 4) targets this.
