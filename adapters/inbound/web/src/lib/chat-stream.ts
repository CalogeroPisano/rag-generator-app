/** Events of the chat stream (`POST /api/chat`, Server-Sent Events). Shared by server and client. */
import { type ChatConversation, type ChatMessage, type ChatSource } from "@code-to-rag/core"

export type ChatMessageWire = typeof ChatMessage.Encoded
export type ChatConversationWire = typeof ChatConversation.Encoded

export interface ChatRequestWire {
  readonly projectId: string
  /** Null starts a new conversation. */
  readonly conversationId: string | null
  readonly question: string
  readonly approvedOnly: boolean
}

export type ChatStreamEvent =
  | { readonly type: "conversation"; readonly conversation: ChatConversationWire }
  | { readonly type: "sources"; readonly sources: ReadonlyArray<ChatSource> }
  | { readonly type: "delta"; readonly text: string }
  | { readonly type: "done"; readonly message: ChatMessageWire }
  | { readonly type: "error"; readonly message: string }

/** Splits a Server-Sent Events buffer into complete `data:` payloads and the unfinished rest. */
export const parseSseFrames = (buffer: string): { readonly payloads: Array<string>; readonly rest: string } => {
  const frames = buffer.split("\n\n")
  const rest = frames.pop() ?? ""
  const payloads = frames.flatMap((frame) => {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
    return data.length === 0 ? [] : [data.join("\n")]
  })
  return { payloads, rest }
}
