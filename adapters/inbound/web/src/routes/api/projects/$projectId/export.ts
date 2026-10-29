import { Export, ProjectId } from "@code-to-rag/core"
import { createFileRoute } from "@tanstack/react-router"
import { Cause, Effect, Exit, Fiber, Option, Schema } from "effect"
import { runtime } from "@/server/runtime.server"
import { getSessionUser } from "@/server/session.server"

const decodeProjectId = Schema.decodeUnknownOption(ProjectId)

const contentTypes: Record<Export.ExportFormat, string> = {
  jsonl: "application/zip",
  sql: "application/sql; charset=utf-8"
}

/** Messages of the errors a user may see before the download starts. */
const refusal = (cause: Cause.Cause<unknown>): Response | undefined => {
  const failure = Cause.findErrorOption(cause)
  if (failure._tag === "None" || typeof failure.value !== "object" || failure.value === null) return undefined
  const error = failure.value as { readonly _tag?: string; readonly message?: string }
  if (error._tag === "NotFoundError") return new Response("Progetto non trovato", { status: 404 })
  if (error._tag === "InvalidInputError") return new Response(error.message ?? "Richiesta non valida", { status: 409 })
  return undefined
}

/**
 * Download of the knowledge of the current version (phase 7): `?format=jsonl` (zip archive) or `?format=sql`, with
 * `&approvedOnly=true` for approved cards only. The file is written while it is read from the database, at the pace
 * of the client; closing the connection stops it.
 */
export const Route = createFileRoute("/api/projects/$projectId/export")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if ((await getSessionUser(request.headers)) === undefined) {
          return new Response("Non autenticato", { status: 401 })
        }
        const projectId = decodeProjectId(params.projectId)
        const search = new URL(request.url).searchParams
        const format = search.get("format")
        if (Option.isNone(projectId) || (format !== "jsonl" && format !== "sql")) {
          return new Response("Richiesta non valida", { status: 400 })
        }
        const prepared = await runtime.runPromiseExit(
          Export.prepareExport(projectId.value, search.get("approvedOnly") === "true")
        )
        if (Exit.isFailure(prepared)) {
          const response = refusal(prepared.cause)
          if (response !== undefined) return response
          await runtime.runPromise(Effect.logError("Export failed", prepared.cause))
          return new Response("Errore interno del server", { status: 500 })
        }
        const plan = prepared.value

        let fiber: Fiber.Fiber<void, unknown> | undefined
        let demand: (() => void) | undefined
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            // Waits for the client to read (pull) when its queue is full: the export is never buffered whole.
            const write = (bytes: Uint8Array) =>
              Effect.promise(() => {
                controller.enqueue(bytes)
                if ((controller.desiredSize ?? 0) > 0) return Promise.resolve()
                return new Promise<void>((resolve) => {
                  demand = resolve
                })
              })
            const program = Export.writeExport(plan, format, write).pipe(
              Effect.matchCauseEffect({
                onSuccess: () => Effect.sync(() => controller.close()),
                onFailure: (cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.void
                    : Effect.logError("Export failed", cause).pipe(
                        // The download ends with an error instead of a truncated file.
                        Effect.andThen(Effect.sync(() => controller.error(new Error("Export failed"))))
                      )
              })
            )
            fiber = runtime.runFork(program)
          },
          pull() {
            demand?.()
            demand = undefined
          },
          cancel() {
            if (fiber !== undefined) runtime.runFork(Fiber.interrupt(fiber))
          }
        })

        const fileName = `${plan.fileName}.${format === "sql" ? "sql" : "zip"}`
        return new Response(stream, {
          headers: {
            "Content-Type": contentTypes[format],
            "Content-Disposition": `attachment; filename="${fileName}"`,
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff"
          }
        })
      }
    }
  }
})
