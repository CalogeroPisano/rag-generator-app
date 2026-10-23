/**
 * Bottom-up summaries: symbols and files (one call per file, or per chunk of a
 * large file), then modules (directories) from the summaries below them.
 */
import { Schema } from "effect"
import type { PromptRef } from "../language-model.ts"
import { COMMON_RULES, numberLines, truncate } from "./format.ts"

const Summary = Schema.String.annotate({
  description: "Two to four sentences: responsibility and behaviour visible to the users of the application."
})

// ---------------------------------------------------------------------------
// File (or chunk of a file)

export const FILE_SUMMARY: PromptRef = { id: "file-summary", version: 1 }

export const FileSummaryOutput = Schema.Struct({
  summary: Summary,
  symbols: Schema.Array(
    Schema.Struct({
      name: Schema.String.annotate({ description: "Qualified name, exactly as listed under 'Declarations'." }),
      summary: Schema.String.annotate({ description: "One sentence: what it does." })
    })
  ).annotate({ description: "One entry per relevant declaration; skip trivial ones (getters, simple fields)." })
})
export type FileSummaryOutput = typeof FileSummaryOutput.Type

export const fileSummaryInstructions = [
  "You document a software application for its end users, starting from its source code.",
  "Summarize the source file you are given and its main declarations.",
  "Focus on what the code does for the application (features, rules, configuration), not on implementation details.",
  COMMON_RULES
].join("\n")

export interface SymbolLine {
  readonly kind: string
  readonly qualifiedName: string
  readonly startLine: number
  readonly endLine: number
}

export const renderFileSummary = (input: {
  readonly path: string
  readonly language: string
  readonly totalLines: number
  /** Lines of this part of the file; `firstLine` is the number of the first one. */
  readonly lines: ReadonlyArray<string>
  readonly firstLine: number
  readonly symbols: ReadonlyArray<SymbolLine>
}): string => {
  const lastLine = input.firstLine + input.lines.length - 1
  const part =
    input.firstLine === 1 && lastLine >= input.totalLines
      ? ""
      : ` (lines ${input.firstLine}-${lastLine} of ${input.totalLines}; the rest of the file is summarized separately)`
  const symbols =
    input.symbols.length === 0
      ? "(none)"
      : input.symbols.map((s) => `- ${s.kind} ${s.qualifiedName} (lines ${s.startLine}-${s.endLine})`).join("\n")
  return [
    `File: ${input.path}${part}`,
    `Language: ${input.language}`,
    "",
    "Declarations:",
    symbols,
    "",
    "Code (each line starts with its number):",
    numberLines(input.lines, input.firstLine)
  ].join("\n")
}

// ---------------------------------------------------------------------------
// Large file: summary from the summaries of its parts

export const FILE_ROLLUP: PromptRef = { id: "file-rollup", version: 1 }

export const RollupOutput = Schema.Struct({ summary: Summary })
export type RollupOutput = typeof RollupOutput.Type

export const fileRollupInstructions = [
  "You document a software application for its end users, starting from its source code.",
  "A large source file was summarized in parts. Write the summary of the whole file from the summaries of its parts.",
  COMMON_RULES
].join("\n")

export const renderFileRollup = (input: {
  readonly path: string
  readonly parts: ReadonlyArray<{ readonly firstLine: number; readonly lastLine: number; readonly summary: string }>
}): string =>
  [
    `File: ${input.path}`,
    "",
    "Summaries of its parts:",
    ...input.parts.map((part) => `- lines ${part.firstLine}-${part.lastLine}: ${part.summary}`)
  ].join("\n")

// ---------------------------------------------------------------------------
// Module (directory)

export const MODULE_SUMMARY: PromptRef = { id: "module-summary", version: 1 }

export const moduleSummaryInstructions = [
  "You document a software application for its end users, starting from its source code.",
  "Summarize a module (a directory of the project) from the summaries of its files and sub-modules.",
  "Describe which features or responsibilities of the application live in this module.",
  COMMON_RULES
].join("\n")

/** Maximum characters of each summary listed in a module prompt. */
export const MODULE_ITEM_CHARS = 600

export const renderModuleSummary = (input: {
  readonly path: string
  readonly files: ReadonlyArray<{ readonly path: string; readonly summary: string }>
  readonly modules: ReadonlyArray<{ readonly path: string; readonly summary: string }>
}): string =>
  [
    `Module: ${input.path === "" ? "(project root)" : input.path}`,
    "",
    "Files:",
    ...(input.files.length === 0
      ? ["(none)"]
      : input.files.map((file) => `- ${file.path}: ${truncate(file.summary, MODULE_ITEM_CHARS)}`)),
    "",
    "Sub-modules:",
    ...(input.modules.length === 0
      ? ["(none)"]
      : input.modules.map((module) => `- ${module.path}/: ${truncate(module.summary, MODULE_ITEM_CHARS)}`))
  ].join("\n")
