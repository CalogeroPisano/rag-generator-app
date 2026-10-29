import { createRequire } from "node:module"
import * as nodePath from "node:path"

/** Grammars bundled with the analyzer. TSX needs its own grammar; JSX is handled by the JavaScript one. */
export type GrammarId = "typescript" | "tsx" | "javascript" | "java" | "csharp" | "go" | "python"

export const grammarIds: ReadonlyArray<GrammarId> = [
  "typescript",
  "tsx",
  "javascript",
  "java",
  "csharp",
  "go",
  "python"
]

/** npm package and wasm file of each grammar (all MIT licensed). */
export const grammarSources: Readonly<Record<GrammarId, { readonly packageName: string; readonly file: string }>> = {
  typescript: { packageName: "tree-sitter-typescript", file: "tree-sitter-typescript.wasm" },
  tsx: { packageName: "tree-sitter-typescript", file: "tree-sitter-tsx.wasm" },
  javascript: { packageName: "tree-sitter-javascript", file: "tree-sitter-javascript.wasm" },
  java: { packageName: "tree-sitter-java", file: "tree-sitter-java.wasm" },
  csharp: { packageName: "tree-sitter-c-sharp", file: "tree-sitter-c_sharp.wasm" },
  go: { packageName: "tree-sitter-go", file: "tree-sitter-go.wasm" },
  python: { packageName: "tree-sitter-python", file: "tree-sitter-python.wasm" }
}

export const RUNTIME_WASM = "web-tree-sitter.wasm"

/** Chooses the grammar from the file extension; `undefined` for languages not analyzed yet. */
export const grammarForPath = (path: string): GrammarId | undefined => {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase()
  if (name.endsWith(".d.ts")) return "typescript"
  const extension = name.slice(name.lastIndexOf(".") + 1)
  switch (extension) {
    case "ts":
    case "mts":
    case "cts":
      return "typescript"
    case "tsx":
      return "tsx"
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "javascript"
    case "java":
      return "java"
    case "cs":
      return "csharp"
    case "go":
      return "go"
    case "py":
    case "pyi":
      return "python"
    default:
      return undefined
  }
}

/**
 * Locations of the wasm files. In production they are copied into one
 * directory (`GRAMMARS_DIR`); in development they are read from node_modules.
 */
export const resolveWasmFiles = (
  grammarsDir: string | undefined
): { readonly runtime: string; readonly grammars: Readonly<Record<GrammarId, string>> } => {
  if (grammarsDir !== undefined) {
    const grammars = Object.fromEntries(
      grammarIds.map((id) => [id, nodePath.join(grammarsDir, grammarSources[id].file)])
    ) as Record<GrammarId, string>
    return { runtime: nodePath.join(grammarsDir, RUNTIME_WASM), grammars }
  }
  const require = createRequire(import.meta.url)
  const grammars = Object.fromEntries(
    grammarIds.map((id) => [id, require.resolve(`${grammarSources[id].packageName}/${grammarSources[id].file}`)])
  ) as Record<GrammarId, string>
  return { runtime: require.resolve(`web-tree-sitter/${RUNTIME_WASM}`), grammars }
}
