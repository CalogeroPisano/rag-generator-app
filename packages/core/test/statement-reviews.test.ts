import { describe, expect, it } from "vitest"
import { carryStatementReviews } from "../src/application/statement-reviews.ts"
import type { CardContent } from "../src/domain/card.ts"

const ref = (startLine: number) => [{ path: "a.ts", startLine, endLine: startLine }]
const content = (
  behavior: ReadonlyArray<[string, number]>,
  limits: ReadonlyArray<[string, number]> = []
): CardContent => ({
  title: "T",
  summary: "S",
  behavior: behavior.map(([text, line]) => ({ text, references: ref(line) })),
  configuration: [],
  parameters: [],
  limits: limits.map(([text, line]) => ({ text, references: ref(line) })),
  validationRules: [],
  errors: []
})
const review = (id: string, verdict: "confirmed" | "wrong") => ({
  id,
  verdict,
  reviewer: "R",
  reviewedAt: "2026-10-30T00:00:00.000Z"
})

describe("carryStatementReviews", () => {
  it("keeps decisions of identical statements under their new ids and drops the others", () => {
    const before = content(
      [
        ["Creates orders.", 1],
        ["Sends an email.", 2],
        ["Logs the order.", 3]
      ],
      [["At most 100 pieces.", 4]]
    )
    const reviews = [
      review("behavior.0", "confirmed"),
      review("behavior.1", "wrong"),
      review("behavior.2", "confirmed"),
      review("limits.0", "confirmed")
    ]
    // The first statement is removed, the second rewritten, a new one added before the third.
    const after = content(
      [
        ["Sends a confirmation email.", 2],
        ["Validates the order.", 5],
        ["Logs the order.", 3]
      ],
      [["At most 100 pieces.", 4]]
    )
    expect(carryStatementReviews(before, after, reviews).map((r) => [r.id, r.verdict])).toEqual([
      ["behavior.2", "confirmed"],
      ["limits.0", "confirmed"]
    ])
  })

  it("does not carry a decision when the references or the section change", () => {
    const before = content([["Creates orders.", 1]])
    const reviews = [review("behavior.0", "confirmed")]
    expect(carryStatementReviews(before, content([["Creates orders.", 9]]), reviews)).toEqual([])
    expect(carryStatementReviews(before, content([], [["Creates orders.", 1]]), reviews)).toEqual([])
  })
})
