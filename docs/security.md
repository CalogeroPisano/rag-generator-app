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
- **CSRF**: server functions and the zip upload only accept same-origin requests.
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

## Known limitations

- Masking is rule-based: credentials in unrecognized formats can slip through. Rules must be extended when new
  formats emerge.
- isomorphic-git keeps the repository pack in memory during the clone; when the timeout expires the job fails but the
  clone is not stopped immediately.
- There are no roles yet: every authenticated user sees every project.
