import { Duration, Effect, Redacted } from "effect"
import * as git from "isomorphic-git"
import http from "isomorphic-git/http/node"
import * as fs from "node:fs"
import { GitError } from "./errors.ts"

export interface CloneOptions {
  readonly url: string
  /** Branch or tag; the remote's default branch when omitted. */
  readonly ref?: string | undefined
  readonly username?: string | undefined
  /** Read-only access token. Never logged, never written to disk by us. */
  readonly token?: Redacted.Redacted | undefined
  readonly directory: string
  readonly allowHttp: boolean
  readonly timeout: Duration.Input
}

export interface CloneResult {
  readonly commit: string
  readonly ref: string | undefined
}

/** Validates a repository URL: https only (http when allowed), no embedded credentials. */
export const validateRepositoryUrl = (raw: string, allowHttp: boolean): GitError | URL => {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return new GitError({ reason: "invalid_url", message: "L'URL del repository non è valido" })
  }
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    return new GitError({
      reason: "invalid_url",
      message: allowHttp ? "Sono supportati solo URL http(s)" : "Sono supportati solo URL https"
    })
  }
  if (url.username !== "" || url.password !== "") {
    return new GitError({
      reason: "invalid_url",
      message: "Non inserire credenziali nell'URL: usa il campo del token di accesso"
    })
  }
  return url
}

const scrub = (message: string, token: string | undefined): string =>
  token === undefined || token.length === 0 ? message : message.replaceAll(token, "[REDACTED]")

const toGitError = (cause: unknown, token: string | undefined): GitError => {
  const error = cause as { code?: string; data?: { statusCode?: number }; message?: string }
  const message = scrub(error.message ?? "Errore Git sconosciuto", token)
  const status = error.data?.statusCode
  if (error.code === "UserCanceledError" || status === 401 || status === 403) {
    return new GitError({ reason: "auth", message: "Autenticazione non riuscita: verifica il token di accesso" })
  }
  if (status === 404 || error.code === "NotFoundError") {
    return new GitError({ reason: "not_found", message: "Repository o branch non trovato" })
  }
  if (error.code === "ENOTFOUND" || error.code === "ECONNREFUSED" || error.code === "ECONNRESET") {
    return new GitError({ reason: "network", message })
  }
  return new GitError({ reason: "other", message })
}

/**
 * Shallow-clones a single branch into `directory` (which must be empty).
 *
 * The token is only handed to isomorphic-git through `onAuth`, so it is never
 * part of the URL, the stored git config or any error message.
 */
export const cloneRepository = Effect.fn("cloneRepository")(function* (options: CloneOptions) {
  const validated = validateRepositoryUrl(options.url, options.allowHttp)
  if (validated instanceof GitError) return yield* validated

  const token = options.token === undefined ? undefined : Redacted.value(options.token)
  const auth = token === undefined ? undefined : { username: options.username ?? "x-access-token", password: token }

  yield* Effect.tryPromise({
    try: () =>
      git.clone({
        fs,
        http,
        dir: options.directory,
        url: validated.toString(),
        ...(options.ref === undefined ? {} : { ref: options.ref }),
        singleBranch: true,
        depth: 1,
        noTags: true,
        ...(auth === undefined ? {} : { onAuth: () => auth }),
        // Without this, a rejected token would make isomorphic-git ask again forever.
        onAuthFailure: () => ({ cancel: true })
      }),
    catch: (cause) => toGitError(cause, token)
  }).pipe(
    Effect.timeoutOrElse({
      duration: options.timeout,
      orElse: () =>
        Effect.fail(new GitError({ reason: "timeout", message: "La clonazione ha superato il tempo massimo" }))
    })
  )

  const commit = yield* Effect.tryPromise({
    try: () => git.resolveRef({ fs, dir: options.directory, ref: "HEAD" }),
    catch: (cause) => toGitError(cause, token)
  })
  const branch = yield* Effect.tryPromise({
    try: () => git.currentBranch({ fs, dir: options.directory }),
    catch: (cause) => toGitError(cause, token)
  })
  return { commit, ref: branch ?? options.ref } satisfies CloneResult
})
