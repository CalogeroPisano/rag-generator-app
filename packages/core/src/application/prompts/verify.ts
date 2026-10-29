/**
 * Verification of a card against the code, by the decision model: one yes/no
 * question per statement ("does the code support it?") and one about rules or
 * limits the card is missing. The state holds the card and the code excerpts.
 */
import type { CardContent, CardReference } from "../../domain/card.ts"
import type { DecisionQuestion, PromptRef } from "../../ports/outbound/models.ts"

export const CARD_VERIFY: PromptRef = { id: "card-verify", version: 2 }

/** Name of the question about missing rules (statement questions are named after the statement id). */
export const MISSING_QUESTION = "missing"

export const statementQuestion = (text: string): DecisionQuestion => ({
  instructions: `According to the source code, is this statement about the feature true? ${text}`
})

export const missingQuestion: DecisionQuestion = {
  instructions:
    "Does the source code show validation rules, limits, error messages or settings visible to the users of the " +
    "feature that none of the card statements mention?",
  criteria: {
    true: "The code has user-visible rules, limits, errors or settings the card does not mention",
    false: "Everything user-visible in the code is covered by the card, or only implementation details are left out"
  }
}

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
 * State of the question on missing rules and of statements without references: the feature, the card and the code
 * it was written from.
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
