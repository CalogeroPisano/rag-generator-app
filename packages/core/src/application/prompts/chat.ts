/**
 * RAG chat: the model answers a user's question from the functional cards
 * retrieved for it, citing them by number. The answer is plain text, streamed.
 */
import type { PromptRef } from "../../ports/outbound/models.ts"
import type { CardContent, CardParameter, CardStatement } from "../../domain/card.ts"

export const CHAT_ANSWER: PromptRef = { id: "chat-answer", version: 1 }

export const chatInstructions = [
  "You are the documentation assistant of a software application. You answer questions of its end users.",
  "Use only the numbered sources given with the question: functional cards, each describing one feature.",
  "Answer in the same language as the question, even though the sources are in English.",
  "Cite the sources you use with their number in square brackets, e.g. [1] or [2][3], right after the sentence",
  "they support. Cite only numbers that exist in the sources.",
  "If the sources do not contain the answer, say so plainly: do not guess and do not use outside knowledge.",
  "Write for end users: plain text, short paragraphs or lists with '- ', no headings, no source code.",
  "Credentials are masked as [REDACTED:<rule>]: never guess or reproduce them."
].join("\n")

/** Card sections in reading order, with the labels used in prompts and chunks. */
export const CARD_TEXT_SECTIONS = [
  { key: "behavior", label: "What it does" },
  { key: "configuration", label: "Configuration" },
  { key: "parameters", label: "Parameters" },
  { key: "limits", label: "Limits" },
  { key: "validationRules", label: "Validation rules" },
  { key: "errors", label: "Errors" }
] as const
export type CardTextSection = (typeof CARD_TEXT_SECTIONS)[number]["key"]

const parameterLine = (p: CardParameter): string => {
  const details = [
    p.type,
    p.required === null ? null : p.required ? "required" : "optional",
    p.defaultValue === null ? null : `default ${p.defaultValue}`
  ].filter((detail): detail is string => detail !== null && detail !== "")
  return `- ${p.name}${details.length === 0 ? "" : ` (${details.join(", ")})`}: ${p.description}`
}

/** Lines of one card section, without references (the chat cites cards, not lines). */
export const cardSectionLines = (card: CardContent, section: CardTextSection): Array<string> => {
  const statements = (items: ReadonlyArray<CardStatement>) => items.map((item) => `- ${item.text}`)
  switch (section) {
    case "parameters":
      return card.parameters.map(parameterLine)
    case "errors":
      return card.errors.map((e) => `- ${e.condition}${e.message === null ? "" : ` (message: "${e.message}")`}`)
    default:
      return statements(card[section])
  }
}

/** A card as plain text: title, feature, summary and the non-empty sections. */
export const renderCardText = (input: { readonly featureName: string; readonly card: CardContent }): string =>
  [
    `${input.card.title} (feature: ${input.featureName})`,
    input.card.summary,
    ...CARD_TEXT_SECTIONS.flatMap(({ key, label }) => {
      const lines = cardSectionLines(input.card, key)
      return lines.length === 0 ? [] : [`${label}:`, ...lines]
    })
  ].join("\n")

/** Last user message: the numbered sources and the question. */
export const renderChatQuestion = (input: {
  /** Pre-rendered with `renderCardText`, numbered from 1 in this order. */
  readonly sources: ReadonlyArray<string>
  readonly question: string
}): string =>
  [
    "Sources:",
    ...(input.sources.length === 0
      ? ["(none: no documentation matches the question)"]
      : input.sources.map((source, i) => `[${i + 1}] ${source}`)),
    "",
    `Question: ${input.question}`
  ].join("\n\n")

/** Source numbers cited in an answer (`[2]`, `[1][3]`, `[1, 3]`), in order of first appearance. */
export const citedSources = (answer: string, sourceCount: number): Array<number> => {
  const cited: Array<number> = []
  for (const match of answer.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) {
    for (const part of (match[1] ?? "").split(",")) {
      const n = Number(part.trim())
      if (Number.isInteger(n) && n >= 1 && n <= sourceCount && !cited.includes(n)) cited.push(n)
    }
  }
  return cited
}
