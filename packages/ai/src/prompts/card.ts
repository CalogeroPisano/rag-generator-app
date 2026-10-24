/**
 * Functional card: the documentation of one feature for end users, written by
 * reading together all the files linked to the feature. Every statement cites
 * the source lines it comes from.
 */
import { Schema } from "effect"
import type { PromptRef } from "../language-model.ts"
import { COMMON_RULES, numberLines } from "./format.ts"

export const CARD: PromptRef = { id: "card", version: 3 }

// Plain numbers: an integer schema adds ±2^53 bounds that weigh on constrained decoding. Callers round them.
export const CardReference = Schema.Struct({
  path: Schema.String.annotate({ description: "File path, exactly as shown in the input." }),
  startLine: Schema.Number,
  endLine: Schema.Number
})
export type CardReference = typeof CardReference.Type

const References = Schema.Array(CardReference).annotate({
  description: "Source lines that support the statement (at least one)."
})

export const CardStatement = Schema.Struct({
  text: Schema.String,
  references: References
})
export type CardStatement = typeof CardStatement.Type

export const CardParameter = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  type: Schema.NullOr(Schema.String).annotate({ description: "Type or accepted values, null if unknown." }),
  required: Schema.NullOr(Schema.Boolean),
  defaultValue: Schema.NullOr(Schema.String),
  references: References
})
export type CardParameter = typeof CardParameter.Type

export const CardError = Schema.Struct({
  condition: Schema.String.annotate({ description: "When the error happens." }),
  message: Schema.NullOr(Schema.String).annotate({ description: "Message shown to the user, if visible in the code." }),
  references: References
})
export type CardError = typeof CardError.Type

/** Structured content of a card (also the stored form, once references are checked). */
export const CardContent = Schema.Struct({
  title: Schema.String,
  summary: Schema.String.annotate({ description: "Two or three sentences for an end user." }),
  behavior: Schema.Array(CardStatement).annotate({ description: "What the feature does, step by step." }),
  configuration: Schema.Array(CardStatement).annotate({ description: "How it is enabled or configured." }),
  parameters: Schema.Array(CardParameter).annotate({ description: "Inputs, options and settings." }),
  limits: Schema.Array(CardStatement).annotate({ description: "Limits: sizes, quotas, timeouts, permissions." }),
  validationRules: Schema.Array(CardStatement).annotate({ description: "Rules the input must satisfy." }),
  errors: Schema.Array(CardError)
})
export type CardContent = typeof CardContent.Type

export const CARD_SECTIONS = ["behavior", "configuration", "parameters", "limits", "validationRules", "errors"] as const
export type CardSection = (typeof CARD_SECTIONS)[number]

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
  /** Current card, when it is being corrected rather than written from scratch. */
  readonly current?: CardContent | null | undefined
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
    ...(input.corrections === undefined || input.corrections.length === 0
      ? []
      : ["", "Reviewer corrections:", ...input.corrections.map((text, i) => `${i + 1}. ${text}`)])
  ].join("\n")
