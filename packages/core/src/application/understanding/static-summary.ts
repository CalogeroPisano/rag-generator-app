/**
 * Summaries written from the code itself, without the language model, for files that carry no behaviour: empty
 * files, files of imports or re-exports only (barrels, side-effect setup), TypeScript files of type definitions only.
 * Fixed rules, no model: any file that does not match one exactly goes to the language model as before.
 */
import type { PromptRef } from "../../ports/outbound/models.ts"
import type { Declaration, FileForUnderstanding, NewFileSummary } from "../../ports/outbound/repositories.ts"

/** Recorded as the prompt of a static summary: bump the version when the rules or the texts change. */
export const STATIC_SUMMARY: PromptRef = { id: "static-summary", version: 1 }

/** Recorded as the model of a static summary. */
export const STATIC_SUMMARY_MODEL = "static-analysis"

const C_LIKE = new Set(["typescript", "javascript", "java", "csharp", "go"])
const SCRIPT = new Set(["typescript", "javascript"])

/** Removes comments, keeping strings as they are (a `//` inside a module path must survive). */
const stripComments = (text: string, language: string): string => {
  if (language === "python") {
    return text
      .replace(/^\s*#.*$/gm, "")
      .replace(/^\s*(?:"""[\s\S]*?"""|'''[\s\S]*?''')/m, "")
      .trim()
  }
  if (!C_LIKE.has(language)) return text.trim()
  let out = ""
  let i = 0
  while (i < text.length) {
    const char = text[i]!
    const next = text[i + 1]
    if (char === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++
    } else if (char === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2)
      i = end === -1 ? text.length : end + 2
    } else if (char === '"' || char === "'" || char === "`") {
      const start = i
      i++
      while (i < text.length && text[i] !== char && text[i] !== "\n") i += text[i] === "\\" ? 2 : 1
      out += text.slice(start, i + 1)
      i++
    } else {
      out += char
      i++
    }
  }
  return out.trim()
}

const MODULE = String.raw`["']([^"'\n]+)["']`
const SCRIPT_STATEMENTS: ReadonlyArray<{ readonly kind: "import" | "reexport" | "other"; readonly pattern: RegExp }> = [
  { kind: "import", pattern: new RegExp(String.raw`^import\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?${MODULE}\s*;?`) },
  {
    kind: "reexport",
    pattern: new RegExp(String.raw`^export\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s+${MODULE}\s*;?`)
  },
  { kind: "other", pattern: /^export\s+(?:type\s+)?\{[^}]*\}\s*;?/ },
  { kind: "other", pattern: /^(["'])use (?:strict|client|server)\1\s*;?/ }
]
const PYTHON_STATEMENTS: ReadonlyArray<{ readonly kind: "import" | "reexport" | "other"; readonly pattern: RegExp }> = [
  { kind: "import", pattern: /^from\s+([\w.]+)\s+import\s+(?:\([^)]*\)|[^\n]+)/ },
  { kind: "import", pattern: /^import\s+([\w.]+)[^\n]*/ },
  { kind: "other", pattern: /^__all__\s*=\s*(?:\[[^\]]*\]|\([^)]*\))/ }
]

/**
 * Splits `text` into import and export statements; undefined when anything else is left (the file does something).
 */
const importsOnly = (
  text: string,
  language: string
): { readonly imports: ReadonlyArray<string>; readonly reexports: ReadonlyArray<string> } | undefined => {
  const statements = SCRIPT.has(language) ? SCRIPT_STATEMENTS : language === "python" ? PYTHON_STATEMENTS : undefined
  if (statements === undefined) return undefined
  const imports: Array<string> = []
  const reexports: Array<string> = []
  let rest = text.trim()
  while (rest !== "") {
    const match = statements.map((s) => ({ s, m: s.pattern.exec(rest) })).find(({ m }) => m !== null)
    if (match?.m == null) return undefined
    const module = match.m[1]
    if (module !== undefined && match.s.kind === "import") imports.push(module)
    if (module !== undefined && match.s.kind === "reexport") reexports.push(module)
    rest = rest.slice(match.m[0].length).trim()
  }
  return { imports, reexports }
}

const list = (items: ReadonlyArray<string>, max = 8): string => {
  const unique = [...new Set(items)]
  const shown = unique.slice(0, max).join(", ")
  return unique.length > max ? `${shown} and ${unique.length - max} more` : shown
}

const TYPE_KINDS = new Set(["interface", "type"])

/**
 * The static summary of a file that carries no behaviour, or undefined when the language model must read it.
 * `declarations` are the file's declarations from the static analysis.
 */
export const staticSummary = (
  file: FileForUnderstanding,
  declarations: ReadonlyArray<Declaration>
): NewFileSummary | undefined => {
  const summary = (text: string, symbols: NewFileSummary["symbols"] = []): NewFileSummary => ({
    path: file.path,
    language: file.language,
    contentHash: file.contentHash,
    summary: text,
    parts: 0,
    symbols
  })
  const code = stripComments(file.content, file.language)
  if (code === "" && (C_LIKE.has(file.language) || file.language === "python")) {
    return summary("Empty file: no code, at most comments.")
  }

  const statements = importsOnly(code, file.language)
  if (statements !== undefined && declarations.length === 0) {
    if (statements.reexports.length > 0) {
      return summary(
        `Index module: re-exports ${list(statements.reexports)}${statements.imports.length > 0 ? `, imports ${list(statements.imports)}` : ""}. No code of its own.`
      )
    }
    if (statements.imports.length > 0 && /(?:^|\/)__init__\.py$/.test(file.path)) {
      // A package index: what it imports is the package's public API.
      return summary(`Package index: exposes ${list(statements.imports)}. No code of its own.`)
    }
    if (statements.imports.length > 0) {
      return summary(`Imports ${list(statements.imports)} for their side effects only. No code of its own.`)
    }
  }

  // TypeScript files of type definitions only: what is left outside the declarations is imports and exports.
  const topLevel = declarations.filter((d) => d.container === null)
  if (file.language === "typescript" && topLevel.length > 0 && topLevel.every((d) => TYPE_KINDS.has(d.kind))) {
    const lines = file.content.split("\n")
    const covered = new Set<number>()
    for (const d of topLevel) for (let line = d.startLine; line <= d.endLine; line++) covered.add(line)
    const outside = lines.filter((_, i) => !covered.has(i + 1)).join("\n")
    if (importsOnly(stripComments(outside, file.language), file.language) !== undefined) {
      const names = topLevel.map((d) => d.qualifiedName)
      return summary(
        `Type definitions only (no runtime code): ${list(names, 12)}.`,
        topLevel.map((d) => ({
          qualifiedName: d.qualifiedName,
          kind: d.kind,
          startLine: d.startLine,
          endLine: d.endLine,
          summary: `${d.kind === "interface" ? "Interface" : "Type"} ${d.qualifiedName}, declared at lines ${d.startLine}-${d.endLine}.`
        }))
      )
    }
  }
  return undefined
}
