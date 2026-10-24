/**
 * Verification of a card against the code: a second reading checks every
 * statement and looks for rules or limits the card is missing.
 */
import { Schema } from "effect"
import type { PromptRef } from "../language-model.ts"
import { CARD_SECTIONS, type CardContent, CardReference } from "./card.ts"
import { COMMON_RULES } from "./format.ts"

export const CARD_VERIFY: PromptRef = { id: "card-verify", version: 1 }

export const CardSectionName = Schema.Literals(CARD_SECTIONS)

export const StatementVerdict = Schema.Literals(["supported", "partial", "unsupported"])
export type StatementVerdict = typeof StatementVerdict.Type

export const CardVerifyOutput = Schema.Struct({
  statements: Schema.Array(
    Schema.Struct({
      id: Schema.String.annotate({ description: "Statement id, exactly as listed (e.g. behavior.0)." }),
      verdict: StatementVerdict.annotate({
        description:
          "supported: the code confirms it; partial: partly right or imprecise; unsupported: not in the code or wrong."
      }),
      note: Schema.String.annotate({ description: "Short reason, especially when not supported (may be empty)." })
    })
  ),
  missing: Schema.Array(
    Schema.Struct({
      section: CardSectionName,
      text: Schema.String.annotate({ description: "What the card should also say, for an end user." }),
      references: Schema.Array(CardReference)
    })
  ).annotate({ description: "Validations, limits, errors or settings visible in the code but missing from the card." })
})
export type CardVerifyOutput = typeof CardVerifyOutput.Type

export const cardVerifyInstructions = [
  "You verify the functional documentation of one feature of a software application against its source code.",
  "For every statement of the card, decide whether the code supports it. Judge the statement, not its wording;",
  "the cited lines are a hint, check the whole excerpt. Then list what is visible in the code but missing from the",
  "card: validation rules, limits, error messages, settings. Do not list implementation details.",
  "Every listed statement id must get exactly one verdict.",
  COMMON_RULES
].join("\n")

/** Card statements with stable ids (`section.index`), as the verifier sees them. */
export const cardStatements = (card: CardContent): Array<{ id: string; text: string; references: string }> => {
  const refs = (references: ReadonlyArray<CardReference>) =>
    references.map((r) => `${r.path}:${r.startLine}-${r.endLine}`).join(", ") || "none"
  return [
    ...card.behavior.map((s, i) => ({ id: `behavior.${i}`, text: s.text, references: refs(s.references) })),
    ...card.configuration.map((s, i) => ({ id: `configuration.${i}`, text: s.text, references: refs(s.references) })),
    ...card.parameters.map((p, i) => ({
      id: `parameters.${i}`,
      text: `${p.name}${p.type === null ? "" : ` (${p.type})`}: ${p.description}${p.required === null ? "" : p.required ? " Required." : " Optional."}${p.defaultValue === null ? "" : ` Default: ${p.defaultValue}.`}`,
      references: refs(p.references)
    })),
    ...card.limits.map((s, i) => ({ id: `limits.${i}`, text: s.text, references: refs(s.references) })),
    ...card.validationRules.map((s, i) => ({
      id: `validationRules.${i}`,
      text: s.text,
      references: refs(s.references)
    })),
    ...card.errors.map((e, i) => ({
      id: `errors.${i}`,
      text: `${e.condition}${e.message === null ? "" : ` (message: "${e.message}")`}`,
      references: refs(e.references)
    }))
  ]
}

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
