/**
 * Splits a file too large for one prompt into parts, cutting preferably where
 * a top-level declaration starts, so that each part holds whole declarations.
 */
import { estimateTokens } from "../prompts/format.ts"

export interface FilePart {
  /** 1-based number of the first line. */
  readonly firstLine: number
  readonly lines: ReadonlyArray<string>
}

/**
 * @param boundaries 1-based lines where a top-level declaration starts.
 * @param maxTokens budget of the code of one part.
 */
export const splitIntoParts = (
  lines: ReadonlyArray<string>,
  boundaries: ReadonlyArray<number>,
  maxTokens: number
): ReadonlyArray<FilePart> => {
  const starts = new Set(boundaries)
  const parts: Array<FilePart> = []
  let first = 0
  while (first < lines.length) {
    // Grow the part line by line while it fits (at least one line, whatever its size).
    let end = first
    let tokens = 0
    while (end < lines.length) {
      const next = estimateTokens(lines[end] ?? "") + 1
      if (end > first && tokens + next > maxTokens) break
      tokens += next
      end++
    }
    if (end < lines.length) {
      // Cut at the last declaration start in the second half of the part, if any.
      for (let cut = end - 1; cut > first + (end - first) / 2; cut--) {
        if (starts.has(cut + 1)) {
          end = cut
          break
        }
      }
    }
    parts.push({ firstLine: first + 1, lines: lines.slice(first, end) })
    first = end
  }
  return parts
}
