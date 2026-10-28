import { askQuestion, type ChatEvent, ChatConversation, ChatMessage, ProjectId } from "@code-to-rag/core"
import { createFileRoute } from "@tanstack/react-router"
import { createCsrfMiddleware } from "@tanstack/react-start"
import { Cause, Effect, Fiber, Option, Schema } from "effect"
import type { ChatStreamEvent } from "@/lib/chat-stream"
import { runtime } from "@/server/runtime.server"
import { getSessionUser } from "@/server/session.server"

const ChatRequest = Schema.Struct({
  projectId: ProjectId,
  conversationId: Schema.NullOr(Schema.String.check(Schema.isUUID())),
  question: Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(4000)),
  approvedOnly: Schema.Boolean
})
const decodeRequest = Schema.decodeUnknownOption(ChatRequest)
const encodeMessage = Schema.encodeSync(ChatMessage)
const encodeConversation = Schema.encodeSync(ChatConversation)

const toWire = (event: ChatEvent): ChatStreamEvent => {
  switch (event.type) {
    case "conversation":
      return { type: "conversation", conversation: encodeConversation(event.conversation) }
    case "done":
      return { type: "done", message: encodeMessage(event.message) }
    default:
      return event
  }
}

/** Messages of the errors a user may see; anything else is logged and reported generically. */
const userMessage = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("_tag" in error)) return undefined
  const tagged = error as { readonly _tag: string; readonly message?: string }
  switch (tagged._tag) {
    case "InvalidInputError":
    case "AiError":
      return tagged.message
    case "NotFoundError":
      return "Progetto o conversazione non trovati"
    default:
      return undefined
  }
}

/**
 * One chat exchange, streamed as Server-Sent Events: the conversation, the
 * sources given to the model, the answer as it is generated, then the stored
 * message. Closing the connection stops the model (the partial answer is kept).
 */
export const Route = createFileRoute("/api/chat")({
  server: {
    middleware: [createCsrfMiddleware()],
    handlers: {
      POST: async ({ request }) => {
        const user = await getSessionUser(request.headers)
        if (user === undefined) return new Response("Non autenticato", { status: 401 })
        const body = decodeRequest(await request.json().catch(() => undefined))
        if (Option.isNone(body)) return new Response("Richiesta non valida", { status: 400 })

        const encoder = new TextEncoder()
        let fiber: Fiber.Fiber<void, unknown> | undefined
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const send = (event: ChatStreamEvent) => {
              try {
                controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`))
              } catch {
                // The client is gone: the fiber is being interrupted.
              }
            }
            const program = askQuestion({ ...body.value, userId: user.id }, (event) => send(toWire(event))).pipe(
              Effect.asVoid,
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.void
                  : Effect.gen(function* () {
                      const failure = Cause.findErrorOption(cause)
                      const message = failure._tag === "Some" ? userMessage(failure.value) : undefined
                      if (message === undefined) yield* Effect.logError("Chat request failed", cause)
                      send({ type: "error", message: message ?? "Errore interno del server" })
                    })
              ),
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
