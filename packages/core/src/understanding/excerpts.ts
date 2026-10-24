/**
 * Chooses what the card prompt shows of the files of a feature: whole files
 * when they fit, otherwise the declarations of the feature (with a little
 * context), then the first lines of the other files; files that still do not
 * fit are listed with their summary only.
 */
import { type CardExcerpt, estimateTokens, renderCardExcerpt } from "@code-to-rag/ai"
import type { FeatureSymbol } from "../domain.ts"
import type { Declaration, FileForUnderstanding } from "../ports.ts"

const CONTEXT_LINES = 3
const HEAD_LINES = 60

/** Line ranges shown to the model, per path: references must fall inside them. */
export type ShownRanges = ReadonlyMap<
  string,
  { readonly totalLines: number; readonly ranges: ReadonlyArray<readonly [number, number]> }
>

export interface CardExcerpts {
  readonly excerpts: ReadonlyArray<CardExcerpt>
  readonly omitted: ReadonlyArray<{ readonly path: string; readonly summary: string | null }>
  readonly shown: ShownRanges
}

const mergeRanges = (ranges: ReadonlyArray<readonly [number, number]>): Array<[number, number]> => {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = []
  for (const [start, end] of sorted) {
    const last = merged.at(-1)
    if (last !== undefined && start <= last[1] + 1) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }
  return merged
}

const excerptOf = (
  file: FileForUnderstanding,
  lines: ReadonlyArray<string>,
  summary: string | null,
  ranges: ReadonlyArray<readonly [number, number]>
): CardExcerpt => ({
  path: file.path,
  language: file.language,
  totalLines: lines.length,
  summary,
  ranges: ranges.map(([start, end]) => ({ firstLine: start, lines: lines.slice(start - 1, end) }))
})

export const buildCardExcerpts = (input: {
  readonly files: ReadonlyArray<FileForUnderstanding>
  readonly summaries: ReadonlyMap<string, string>
  readonly featureSymbols: ReadonlyArray<FeatureSymbol>
  readonly declarations: ReadonlyArray<Declaration>
  /** Ranges that must be shown like the feature declarations (e.g. the references of a card being verified). */
  readonly extraRanges?: ReadonlyArray<{ readonly path: string; readonly startLine: number; readonly endLine: number }>
  /** Token budget of the rendered excerpts. */
  readonly maxTokens: number
}): CardExcerpts => {
  const symbolNames = new Set(input.featureSymbols.map((s) => `${s.path}\u0000${s.qualifiedName}`))
  const symbolRanges = new Map<string, Array<readonly [number, number]>>()
  for (const declaration of input.declarations) {
    if (!symbolNames.has(`${declaration.path}\u0000${declaration.qualifiedName}`)) continue
    symbolRanges.set(declaration.path, [
      ...(symbolRanges.get(declaration.path) ?? []),
      [declaration.startLine, declaration.endLine] as const
    ])
  }
  for (const range of input.extraRanges ?? []) {
    symbolRanges.set(range.path, [...(symbolRanges.get(range.path) ?? []), [range.startLine, range.endLine] as const])
  }
  // Files with declarations of the feature first: they matter most.
  const ordered = [...input.files].sort(
    (a, b) => Number(symbolRanges.has(b.path)) - Number(symbolRanges.has(a.path)) || a.content.length - b.content.length
  )

  const prepared = ordered.map((file) => {
    const lines = file.content.split("\n")
    const summary = input.summaries.get(file.path) ?? null
    const whole: Array<readonly [number, number]> = [[1, lines.length]]
    const declared = symbolRanges.get(file.path)
    const reduced: Array<readonly [number, number]> =
      declared === undefined
        ? [[1, Math.min(lines.length, HEAD_LINES)]]
        : mergeRanges(
            declared.map(
              ([start, end]) =>
                [Math.max(1, start - CONTEXT_LINES), Math.min(lines.length, end + CONTEXT_LINES)] as const
            )
          )
    return { file, lines, summary, whole, reduced }
  })

  const cost = (excerpt: CardExcerpt) => estimateTokens(renderCardExcerpt(excerpt))
  const all = prepared.map((p) => excerptOf(p.file, p.lines, p.summary, p.whole))
  const fits = (excerpts: ReadonlyArray<CardExcerpt>) =>
    excerpts.reduce((total, excerpt) => total + cost(excerpt), 0) <= input.maxTokens

  let chosen: Array<{ excerpt: CardExcerpt; ranges: ReadonlyArray<readonly [number, number]> }> = []
  const omitted: Array<{ path: string; summary: string | null }> = []
  if (fits(all)) {
    chosen = prepared.map((p, i) => ({ excerpt: all[i] as CardExcerpt, ranges: p.whole }))
  } else {
    let used = 0
    for (const p of prepared) {
      // Whole file when small enough, otherwise its reduced form, otherwise only its summary.
      const candidates = [p.whole, p.reduced].map((ranges) => {
        const excerpt = excerptOf(p.file, p.lines, p.summary, ranges)
        return { excerpt, ranges, tokens: cost(excerpt) }
      })
      const whole = candidates[0]
      const reduced = candidates[1]
      const pick =
        whole !== undefined && whole.tokens <= (input.maxTokens - used) / 2
          ? whole
          : reduced !== undefined && reduced.tokens <= input.maxTokens - used
            ? reduced
            : undefined
      if (pick === undefined) {
        omitted.push({ path: p.file.path, summary: p.summary })
        continue
      }
      used += pick.tokens
      chosen.push({ excerpt: pick.excerpt, ranges: pick.ranges })
    }
  }

  return {
    excerpts: chosen.map((c) => c.excerpt),
    omitted,
    shown: new Map(chosen.map((c) => [c.excerpt.path, { totalLines: c.excerpt.totalLines, ranges: c.ranges }]))
  }
}
