import { notFound } from "@tanstack/react-router"
import { setResponseStatus } from "@tanstack/react-start/server"
import { Cause, Effect, Exit } from "effect"
import { type AppServices, runtime } from "./runtime.server.ts"

/** An error whose message is safe to show to the user. */
interface UserFacingError {
  readonly message: string
  readonly status: number
}

const userFacing = (error: unknown): UserFacingError | "not_found" | undefined => {
  if (typeof error !== "object" || error === null || !("_tag" in error)) return undefined
  const tagged = error as { readonly _tag: string; readonly message?: string; readonly reason?: string }
  switch (tagged._tag) {
    case "NotFoundError":
      return "not_found"
    case "InvalidInputError":
      return { message: tagged.message ?? "Dati non validi", status: 400 }
    case "ForbiddenError":
      return { message: tagged.message ?? "Operazione non consentita", status: 403 }
    case "UploadError":
      return {
        message: tagged.message ?? "Caricamento non riuscito",
        status: tagged.reason === "too_large" ? 413 : 400
      }
    case "SchemaError":
      return { message: "Dati non validi", status: 400 }
    // Model errors carry a short Italian description, never prompt or answer text.
    case "AiError":
      return { message: tagged.message ?? "Errore del modello", status: 502 }
    default:
      return undefined
  }
}

/**
 * Runs an Effect program on the shared runtime and converts its outcome into
 * something TanStack Start understands: expected errors become `notFound()` or
 * an error with a user-facing message and status; anything else is logged
 * server-side and surfaces as a generic error (no internals leak to the client).
 */
export const runEffect = async <A, E>(effect: Effect.Effect<A, E, AppServices>): Promise<A> => {
  const exit = await runtime.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) return exit.value

  const failure = Cause.findErrorOption(exit.cause)
  const mapped = failure._tag === "Some" ? userFacing(failure.value) : undefined
  if (mapped === "not_found") throw notFound()
  if (mapped !== undefined) {
    setResponseStatus(mapped.status)
    throw new Error(mapped.message)
  }
  await runtime.runPromise(Effect.logError("Request failed", exit.cause))
  setResponseStatus(500)
  throw new Error("Errore interno del server")
}
