import type { getCard } from "@/functions/understanding.functions"

export type CardData = Awaited<ReturnType<typeof getCard>>
export type Content = CardData["content"]
export type Reference = Content["behavior"][number]["references"][number]
export type SectionName = "behavior" | "configuration" | "parameters" | "limits" | "validationRules" | "errors"

export const sectionLabels: Record<SectionName, string> = {
  behavior: "Cosa fa",
  configuration: "Configurazione",
  parameters: "Parametri",
  limits: "Limiti",
  validationRules: "Regole di validazione",
  errors: "Errori"
}

export const SECTIONS: ReadonlyArray<SectionName> = [
  "behavior",
  "configuration",
  "parameters",
  "limits",
  "validationRules",
  "errors"
]

/** A statement of a card with the id used by the verification (`section.index`). */
export interface Statement {
  readonly id: string
  readonly section: SectionName
  readonly index: number
  readonly references: ReadonlyArray<Reference>
}

export const statementsOf = (content: Content): Array<Statement> =>
  SECTIONS.flatMap((section) =>
    content[section].map((item, index) => ({
      id: `${section}.${index}`,
      section,
      index,
      references: item.references
    }))
  )

export const allReferences = (content: Content): Array<Reference> =>
  statementsOf(content).flatMap((statement) => statement.references)

export const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1)

export const formatReference = (reference: Reference) =>
  `${fileName(reference.path)}:${reference.startLine}${reference.endLine === reference.startLine ? "" : `–${reference.endLine}`}`

export type StatementReviewVerdict = CardData["statementReviews"][number]["verdict"]

/**
 * Statements still to be checked by the reviewer: no decision of theirs, and the automatic verification did not
 * confirm them (or there is no current verification, or they have no references).
 */
export const statementsToCheck = (card: CardData): Array<Statement> => {
  const current = card.verification !== null && card.verification.cardVersion === card.version
  const verdicts = new Map(current ? card.verification.statements.map((s) => [s.id, s.verdict]) : [])
  const decided = new Set(card.statementReviews.map((review) => review.id))
  return statementsOf(card.content).filter(
    (statement) =>
      !decided.has(statement.id) && (statement.references.length === 0 || verdicts.get(statement.id) !== "supported")
  )
}

/** Statements the reviewer marked as wrong. */
export const wrongStatements = (card: CardData): Array<Statement> => {
  const wrong = new Set(card.statementReviews.filter((r) => r.verdict === "wrong").map((r) => r.id))
  return statementsOf(card.content).filter((statement) => wrong.has(statement.id))
}
