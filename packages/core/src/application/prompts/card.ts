/**
 * Functional card: the documentation of one feature for end users, written by
 * reading together all the files linked to the feature. Every statement cites
 * the source lines it comes from.
 */
import type { CardContent } from "../../domain/card.ts"
import type { PromptRef } from "../../ports/outbound/models.ts"
import { COMMON_RULES, numberLines } from "./format.ts"

export const CARD: PromptRef = { id: "card", version: 4 }

export const cardInstructions = [
  "You write the functional documentation of one feature of a software application, for its end users.",
  "Read all the source excerpts together and describe what the feature does, how it is configured, its parameters,",
  "its limits, the validation rules applied to the input and the errors the user can get.",
  "Write for users, not developers: describe behaviour, not code. Use empty arrays for sections that do not apply.",
  "Every statement must cite the lines that support it, as path + startLine + endLine taken from the line numbers",
  "shown in the excerpts. Do not cite lines you were not shown.",
  "Be concise: at most 6 items per section, each a single sentence of at most 25 words, usually one reference each.",
  "Reviewer corrections, when present, describe mistakes of earlier versions of this card: apply each one when the",
  "code confirms it; if the code clearly contradicts a correction, follow the code.",
  COMMON_RULES
].join("\n")

export interface CardExcerpt {
  readonly path: string
  readonly language: string
  readonly totalLines: number
  readonly summary: string | null
  /** Ranges of lines included in the prompt (the whole file when it fits). */
  readonly ranges: ReadonlyArray<{ readonly firstLine: number; readonly lines: ReadonlyArray<string> }>
}

export const renderCardExcerpt = (excerpt: CardExcerpt): string => {
  const complete =
    excerpt.ranges.length === 1 &&
    excerpt.ranges[0]?.firstLine === 1 &&
    excerpt.ranges[0].lines.length === excerpt.totalLines
  return [
    `=== ${excerpt.path} (${excerpt.language}, ${excerpt.totalLines} lines${complete ? "" : ", excerpts"})`,
    ...(excerpt.summary === null ? [] : [`Summary: ${excerpt.summary}`]),
    ...excerpt.ranges.map((range) => numberLines(range.lines, range.firstLine))
  ].join("\n")
}

export const renderCard = (input: {
  readonly feature: { readonly name: string; readonly description: string }
  /** Pre-rendered with `renderCardExcerpt`, so that callers can size the prompt. */
  readonly excerpts: ReadonlyArray<string>
  /** Linked files that did not fit: only their summary. */
  readonly omitted: ReadonlyArray<{ readonly path: string; readonly summary: string | null }>
  /** Reviewer corrections of the feature, oldest first. */
  readonly corrections?: ReadonlyArray<string> | undefined
  /** Current card, when it is being corrected or updated rather than written from scratch. */
  readonly current?: CardContent | null | undefined
  /** Files of the feature that changed since the current card was written (incremental update). */
  readonly changedFiles?: ReadonlyArray<string> | undefined
}): string =>
  [
    `Feature: ${input.feature.name}`,
    `Description: ${input.feature.description}`,
    "",
    "Source excerpts (each line starts with its number):",
    ...input.excerpts,
    ...(input.omitted.length === 0
      ? []
      : [
          "",
          "Other files of the feature (not shown, do not cite them):",
          ...input.omitted.map((file) => `- ${file.path}${file.summary === null ? "" : `: ${file.summary}`}`)
        ]),
    ...(input.current === undefined || input.current === null
      ? []
      : ["", "Current card (update it; keep what is still correct):", JSON.stringify(input.current)]),
    ...(input.changedFiles === undefined || input.changedFiles.length === 0
      ? []
      : [
          "",
          "The code changed since the current card was written. Changed, added or removed files:",
          ...input.changedFiles.map((path) => `- ${path}`),
          "Check every statement and reference of the current card against the excerpts above: line numbers may have",
          "moved. Remove what no longer holds and add what the new code does."
        ]),
    ...(input.corrections === undefined || input.corrections.length === 0
      ? []
      : ["", "Reviewer corrections:", ...input.corrections.map((text, i) => `${i + 1}. ${text}`)])
  ].join("\n")
