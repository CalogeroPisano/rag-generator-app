import { isTerminalStatus, type Job, JobId, Jobs } from "@code-to-rag/core"
import { createFileRoute } from "@tanstack/react-router"
import { Effect, Fiber, Option, Schema } from "effect"
import type { JobEventWire, JobStateWire } from "@/lib/job-stream"
import { runtime } from "@/server/runtime.server"
import { getSessionUser } from "@/server/session.server"

const decodeJobId = Schema.decodeUnknownOption(JobId)

const toState = (job: Job): JobStateWire => ({
  id: job.id,
  type: job.type,
  status: job.status,
  currentPhase: job.currentPhase,
  completedPhases: job.completedPhases,
  attempts: job.attempts,
  maxAttempts: job.maxAttempts,
  lastError: job.lastError,
  progress: job.progress,
  update: job.payload !== null && "baseSnapshotId" in job.payload
})

/**
 * Server-Sent Events with the progress of a job. Each job event is sent with
 * its id, so a reconnecting EventSource resumes from `Last-Event-ID`; the
 * current job state follows every batch. The stream ends when the job reaches
 * a terminal state.
 */
export const Route = createFileRoute("/api/jobs/$jobId/events")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if ((await getSessionUser(request.headers)) === undefined) {
          return new Response("Non autenticato", { status: 401 })
        }
        const jobId = decodeJobId(params.jobId)
        if (Option.isNone(jobId)) return new Response("Job non valido", { status: 400 })

        const resumeFrom = Number(request.headers.get("last-event-id") ?? "0")
        const encoder = new TextEncoder()
        let fiber: Fiber.Fiber<void, unknown> | undefined

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const send = (chunk: string) => Effect.sync(() => controller.enqueue(encoder.encode(chunk)))
            const program = Effect.gen(function* () {
              let cursor = Number.isSafeInteger(resumeFrom) && resumeFrom > 0 ? resumeFrom : 0
              let first = true
              yield* send("retry: 3000\n\n")

              for (;;) {
                const events = yield* Jobs.jobEventsAfter(jobId.value, cursor)
                for (const event of events) {
                  const wire: JobEventWire = {
                    id: event.id,
                    kind: event.kind,
                    phase: event.phase,
                    message: event.message,
                    progress: event.progress,
                    createdAt: event.createdAt.toISOString()
                  }
                  yield* send(`id: ${event.id}\nevent: job-event\ndata: ${JSON.stringify(wire)}\n\n`)
                  cursor = event.id
                }
                const job = yield* Jobs.getJob(jobId.value)
                if (first || events.length > 0) {
                  yield* send(`event: job\ndata: ${JSON.stringify(toState(job))}\n\n`)
                  first = false
                }
                // A full page means there may be more events to drain before stopping.
                if (isTerminalStatus(job.status) && events.length < 500) return
                if (events.length === 0) yield* send(": keepalive\n\n")
                yield* Jobs.waitForJobEvent(jobId.value, "5 seconds")
              }
            }).pipe(
              Effect.catchTag("NotFoundError", () => send(`event: not-found\ndata: {}\n\n`)),
              Effect.catchCause((cause) => Effect.logError("Job event stream failed", cause)),
              Effect.ensuring(
                Effect.sync(() => {
                  try {
                    controller.close()
                  } catch {
                    // Already closed by the client.
                  }
                })
              )
            )
            fiber = runtime.runFork(program)
          },
          cancel() {
            if (fiber !== undefined) runtime.runFork(Fiber.interrupt(fiber))
          }
        })

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no"
          }
        })
      }
    }
  }
})
