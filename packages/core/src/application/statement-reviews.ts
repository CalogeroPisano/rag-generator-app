/**
 * Reviewer decisions on statements across a manual edit: a statement left identical (same section, same text and
 * fields, same references) keeps its decision under its new id; changed and new statements start without one.
 */
import type { CardContent } from "../domain/card.ts"
import type { StatementReview } from "../domain/model.ts"
import { cardStatements } from "./prompts/verify.ts"

const sectionOf = (id: string) => id.slice(0, id.indexOf("."))

export const carryStatementReviews = (
  before: CardContent,
  after: CardContent,
  reviews: ReadonlyArray<StatementReview>
): Array<StatementReview> => {
  const byId = new Map(reviews.map((review) => [review.id, review]))
  // Statements of the previous version with a decision, still unmatched, in order (identical ones pair one to one).
  const pending = cardStatements(before).filter((statement) => byId.has(statement.id))
  const carried: Array<StatementReview> = []
  for (const statement of cardStatements(after)) {
    const index = pending.findIndex(
      (old) =>
        sectionOf(old.id) === sectionOf(statement.id) &&
        old.text === statement.text &&
        old.references === statement.references
    )
    if (index === -1) continue
    const [old] = pending.splice(index, 1)
    carried.push({ ...byId.get(old!.id)!, id: statement.id })
  }
  return carried
}
