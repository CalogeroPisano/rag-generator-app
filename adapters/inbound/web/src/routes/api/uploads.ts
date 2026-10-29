import { Projects } from "@code-to-rag/core"
import { createFileRoute } from "@tanstack/react-router"
import { createCsrfMiddleware } from "@tanstack/react-start"
import { Effect } from "effect"
import { runtime } from "@/server/runtime.server"
import { getSessionUser } from "@/server/session.server"

const json = (body: unknown, status: number) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } })

/**
 * Receives a zip archive as the raw request body (no multipart), streaming it
 * to disk. Returns the upload id to pass to `createProject`.
 */
export const Route = createFileRoute("/api/uploads")({
  server: {
    middleware: [createCsrfMiddleware()],
    handlers: {
      POST: async ({ request }) => {
        if ((await getSessionUser(request.headers)) === undefined) return json({ error: "Non autenticato" }, 401)
        if (request.body === null) return json({ error: "Nessun file ricevuto" }, 400)

        const result = await runtime.runPromise(
          Projects.receiveUpload(request.body).pipe(
            Effect.map(({ uploadId, size }) => json({ uploadId, size }, 201)),
            Effect.catchTag("UploadError", (error) =>
              Effect.succeed(json({ error: error.message }, error.reason === "too_large" ? 413 : 400))
            ),
            Effect.catchCause((cause) =>
              Effect.logError("Upload failed", cause).pipe(Effect.as(json({ error: "Caricamento non riuscito" }, 500)))
            )
          )
        )
        return result
      }
    }
  }
})
