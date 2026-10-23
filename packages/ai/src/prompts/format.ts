/**
 * Conservative token estimate (about 3 characters per token for code). Used to
 * size prompts to the model's context window; providers count the real tokens.
 */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 3)

/** Prefixes every line with its number, so the model can cite line ranges. */
export const numberLines = (lines: ReadonlyArray<string>, firstLine = 1): string => {
  const width = String(firstLine + lines.length - 1).length
  return lines.map((line, index) => `${String(firstLine + index).padStart(width)}| ${line}`).join("\n")
}

/** Shortens a text to `max` characters, marking the cut. */
export const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`

/** Shared rules, included in every system prompt. */
export const COMMON_RULES = [
  "Write in English.",
  "The code has been masked: credentials appear as [REDACTED:<rule>]. Never guess or reproduce secret values.",
  "Base every statement on the code you are given. If something is not visible in the code, leave it out.",
  "Answer with a single JSON object matching the requested schema, without any other text."
].join("\n")
