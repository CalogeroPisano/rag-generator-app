/**
 * Verification of a card against the code. The decision model answers one
 * yes/no question per statement ("does the code support it?"); the language
 * model lists the rules or limits the card is missing (a decision model writes
 * no text, so it cannot list them).
 */
import { Schema } from "effect"
import { type CardContent, CardReference, CardSectionName } from "../../domain/card.ts"
import type { DecisionQuestion, PromptRef } from "../../ports/outbound/models.ts"
import { COMMON_RULES } from "./format.ts"

/** Questions of the decision model on the statements. */
export const CARD_VERIFY: PromptRef = { id: "card-verify", version: 3 }

export const statementQuestion = (text: string): DecisionQuestion => ({
  instructions: `According to the source code, is this statement about the feature true? ${text}`
})

/** Language model prompt: what the code shows and the card does not say. */
export const CARD_MISSING: PromptRef = { id: "card-missing", version: 2 }

export const CardMissingOutput = Schema.Struct({
  missing: Schema.Array(
    Schema.Struct({
      section: CardSectionName,
      text: Schema.String.annotate({ description: "What the card should also say, for an end user." }),
      references: Schema.Array(CardReference)
    })
  ).annotate({ description: "Validations, limits, errors or settings visible in the code but missing from the card." })
})
export type CardMissingOutput = typeof CardMissingOutput.Type

export const cardMissingInstructions = [
  "You review the functional documentation of one feature of a software application against its source code.",
  "List what the code does that matters to the users of the feature but is missing from the card: validation rules",
  "it enforces, limits it applies, error messages it shows, settings it reads. Every item must describe something",
  "the cited lines actually do. Never list what the code does not do (a check, a message or a limit that is absent),",
  "never suggest improvements, and do not list implementation details or what the card already says in other words.",
  "Cite the lines that show each item. An empty list is a valid answer.",
  COMMON_RULES
].join("\n")

/** Card statements with stable ids (`section.index`), as the verifier sees them. */
export const cardStatements = (
  card: CardContent
): Array<{ id: string; text: string; references: string; cited: ReadonlyArray<CardReference> }> => {
  const item = (id: string, text: string, cited: ReadonlyArray<CardReference>) => ({
    id,
    text,
    references: cited.map((r) => `${r.path}:${r.startLine}-${r.endLine}`).join(", ") || "none",
    cited
  })
  return [
    ...card.behavior.map((s, i) => item(`behavior.${i}`, s.text, s.references)),
    ...card.configuration.map((s, i) => item(`configuration.${i}`, s.text, s.references)),
    ...card.parameters.map((p, i) =>
      item(
        `parameters.${i}`,
        `${p.name}${p.type === null ? "" : ` (${p.type})`}: ${p.description}${p.required === null ? "" : p.required ? " Required." : " Optional."}${p.defaultValue === null ? "" : ` Default: ${p.defaultValue}.`}`,
        p.references
      )
    ),
    ...card.limits.map((s, i) => item(`limits.${i}`, s.text, s.references)),
    ...card.validationRules.map((s, i) => item(`validationRules.${i}`, s.text, s.references)),
    ...card.errors.map((e, i) =>
      item(`errors.${i}`, `${e.condition}${e.message === null ? "" : ` (message: "${e.message}")`}`, e.references)
    )
  ]
}

/** State of the questions on statements that cite code: the feature and the cited lines only. */
export const renderStatementState = (input: {
  readonly feature: { readonly name: string; readonly description: string }
  /** Pre-rendered with `renderCardExcerpt`. */
  readonly excerpts: ReadonlyArray<string>
}): string =>
  [
    `Feature: ${input.feature.name}`,
    `Description: ${input.feature.description}`,
    "",
    "Source code cited by the statement (each line starts with its number):",
    ...input.excerpts
  ].join("\n")

/**
 * The card next to the code of the whole feature: input of the missing-items prompt and state of the questions on
 * statements without references.
 */
export const renderCardVerify = (input: {
  readonly feature: { readonly name: string; readonly description: string }
  readonly card: CardContent
  /** Pre-rendered with `renderCardExcerpt`. */
  readonly excerpts: ReadonlyArray<string>
}): string =>
  [
    `Feature: ${input.feature.name}`,
    `Description: ${input.feature.description}`,
    "",
    `Card: ${input.card.title}`,
    input.card.summary,
    "",
    "Statements:",
    ...cardStatements(input.card).map((s) => `- [${s.id}] ${s.text} (cites: ${s.references})`),
    "",
    "Source excerpts (each line starts with its number):",
    ...input.excerpts
  ].join("\n")
