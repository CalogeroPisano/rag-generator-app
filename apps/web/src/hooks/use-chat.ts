import type { ChatSource } from "@code-to-rag/core"
import { useCallback, useEffect, useRef, useState } from "react"
import {
  type ChatConversationWire,
  type ChatMessageWire,
  type ChatRequestWire,
  type ChatStreamEvent,
  parseSseFrames
} from "@/lib/chat-stream"

/** An answer being streamed: shown until the stored message arrives. */
export interface PendingAnswer {
  readonly question: string
  readonly sources: ReadonlyArray<ChatSource>
  readonly text: string
}

export interface ChatState {
  readonly pending: PendingAnswer | undefined
  readonly error: string | undefined
  readonly streaming: boolean
}

/**
 * Sends questions to `POST /api/chat` and follows the streamed answer. The
 * stored conversation is reloaded by the caller (`onSettled`) once the
 * exchange ends; `stop` closes the connection, which stops the model.
 */
export function useChat(options: {
  readonly onConversation: (conversation: ChatConversationWire) => void
  readonly onSettled: (message: ChatMessageWire | undefined) => void
}) {
  const [state, setState] = useState<ChatState>({ pending: undefined, error: undefined, streaming: false })
  const controller = useRef<AbortController | undefined>(undefined)
  const callbacks = useRef(options)
  useEffect(() => {
    callbacks.current = options
  })
  useEffect(() => () => controller.current?.abort(), [])

  const send = useCallback(async (request: ChatRequestWire) => {
    controller.current?.abort()
    const abort = new AbortController()
    controller.current = abort
    setState({ pending: { question: request.question, sources: [], text: "" }, error: undefined, streaming: true })
    let stored: ChatMessageWire | undefined
    const handle = (event: ChatStreamEvent) => {
      switch (event.type) {
        case "conversation":
          callbacks.current.onConversation(event.conversation)
          break
        case "sources":
          setState((s) => (s.pending === undefined ? s : { ...s, pending: { ...s.pending, sources: event.sources } }))
          break
        case "delta":
          setState((s) =>
            s.pending === undefined ? s : { ...s, pending: { ...s.pending, text: s.pending.text + event.text } }
          )
          break
        case "done":
          stored = event.message
          break
        case "error":
          setState((s) => ({ ...s, error: event.message }))
      }
    }
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: abort.signal
      })
      if (!response.ok || response.body === null) {
        setState((s) => ({
          ...s,
          error: response.status === 401 ? "Sessione scaduta: accedi di nuovo" : "Richiesta non riuscita"
        }))
        return
      }
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
      let buffer = ""
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        const { payloads, rest } = parseSseFrames(buffer + value)
        buffer = rest
        for (const payload of payloads) handle(JSON.parse(payload) as ChatStreamEvent)
      }
    } catch {
      if (!abort.signal.aborted) setState((s) => ({ ...s, error: "Connessione interrotta" }))
    } finally {
      if (controller.current === abort) {
        controller.current = undefined
        // The server stores the answer in every case (complete, failed or interrupted): the reloaded
        // conversation replaces the pending one.
        setState((s) => ({ ...s, streaming: false, pending: undefined }))
        callbacks.current.onSettled(stored)
      }
    }
  }, [])

  const stop = useCallback(() => controller.current?.abort(), [])
  const reset = useCallback(() => {
    controller.current?.abort()
    setState({ pending: undefined, error: undefined, streaming: false })
  }, [])

  return { ...state, send, stop, reset }
}
