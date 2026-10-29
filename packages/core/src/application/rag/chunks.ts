/**
 * Text units of the embedding index: one overview chunk per card (title,
 * feature, summary) plus one chunk per non-empty section, prefixed with the
 * card title so that each chunk is understandable on its own.
 */
import { CARD_TEXT_SECTIONS, cardSectionLines } from "../prompts/chat.ts"
import { type CardContent } from "../../domain/card.ts"
import { type PromptRef } from "../../ports/outbound/models.ts"

/** Format of the chunk texts: bump the version when `cardChunks` changes (the index is rebuilt). */
export const CARD_CHUNK: PromptRef = { id: "card-chunk", version: 1 }
/** Embedding of a chat question (call log only). */
export const CHAT_QUERY: PromptRef = { id: "chat-query", version: 1 }

/** Longest chunk text, in characters: embedding models have a small input window. */
const MAX_CHUNK_CHARS = 2000

const cut = (text: string): string => (text.length <= MAX_CHUNK_CHARS ? text : text.slice(0, MAX_CHUNK_CHARS))

export const cardChunks = (
  featureName: string,
  card: CardContent
): Array<{ readonly section: string; readonly text: string }> => [
  { section: "overview", text: cut(`${card.title} (feature: ${featureName})\n${card.summary}`) },
  ...CARD_TEXT_SECTIONS.flatMap(({ key, label }) => {
    const lines = cardSectionLines(card, key)
    return lines.length === 0 ? [] : [{ section: key, text: cut([`${card.title}: ${label}`, ...lines].join("\n")) }]
  })
]
