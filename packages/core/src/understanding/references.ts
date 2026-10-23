/**
 * Checks the references of a generated card against the lines the model was
 * shown: references to other files or lines are dropped (never invented), line
 * numbers are rounded and ordered. Statements left without references are
 * counted: verification (phase 4) looks at them first.
 */
import type { CardContent, CardReference } from "@code-to-rag/ai"
import type { NewCardReference } from "../ports.ts"
import type { ShownRanges } from "./excerpts.ts"

export interface CheckedCard {
  readonly content: CardContent
  readonly references: ReadonlyArray<NewCardReference>
  readonly unreferencedStatements: number
}

const normalizePath = (path: string): string => path.trim().replace(/^\.?\//, "")

export const checkReferences = (content: CardContent, shown: ShownRanges): CheckedCard => {
  const rows: Array<NewCardReference> = []
  let unreferenced = 0

  const check = (references: ReadonlyArray<CardReference>): Array<CardReference> =>
    references.flatMap((reference) => {
      const path = normalizePath(reference.path)
      const file = shown.get(path)
      if (file === undefined) return []
      let start = Math.round(reference.startLine)
      let end = Math.round(reference.endLine)
      if (end < start) [start, end] = [end, start]
      start = Math.max(1, start)
      end = Math.min(file.totalLines, end)
      if (start > end) return []
      // The range must overlap what the model was shown.
      if (!file.ranges.some(([first, last]) => start <= last && end >= first)) return []
      return [{ path, startLine: start, endLine: end }]
    })

  const section = <T extends { readonly references: ReadonlyArray<CardReference> }>(
    name: string,
    items: ReadonlyArray<T>,
    claim: (item: T) => string
  ): Array<T> =>
    items.map((item, itemIndex) => {
      const references = check(item.references)
      if (references.length === 0) unreferenced++
      for (const reference of references) rows.push({ section: name, itemIndex, claim: claim(item), ...reference })
      return { ...item, references }
    })

  const checked: CardContent = {
    title: content.title,
    summary: content.summary,
    behavior: section("behavior", content.behavior, (item) => item.text),
    configuration: section("configuration", content.configuration, (item) => item.text),
    parameters: section("parameters", content.parameters, (item) => `${item.name}: ${item.description}`),
    limits: section("limits", content.limits, (item) => item.text),
    validationRules: section("validationRules", content.validationRules, (item) => item.text),
    errors: section("errors", content.errors, (item) => item.condition)
  }
  return { content: checked, references: rows, unreferencedStatements: unreferenced }
}
