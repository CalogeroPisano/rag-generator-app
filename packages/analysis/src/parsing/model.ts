import { Schema } from "effect"
import type { GrammarId } from "./grammars.ts"

/**
 * Version of the extraction and resolution rules. Bump it when they change,
 * so that snapshots analyzed with older rules can be recognised and re-analyzed.
 */
export const ANALYZER_VERSION = "1"

export const SymbolKind = Schema.Literals([
  "namespace",
  "module",
  "class",
  "interface",
  "enum",
  "struct",
  "record",
  "type",
  "function",
  "method",
  "constructor",
  "property",
  "field",
  "constant",
  "variable"
])
export type SymbolKind = typeof SymbolKind.Type

/** A declaration found in a file. Lines are 1-based and refer to the masked content (same lines as the original). */
export interface CodeSymbol {
  readonly kind: SymbolKind
  readonly name: string
  /** Dotted path of enclosing declarations, e.g. `OrderService.create` or `Acme.Orders.OrderService`. */
  readonly qualifiedName: string
  /** Qualified name of the enclosing declaration, `null` at top level. */
  readonly container: string | null
  readonly startLine: number
  readonly endLine: number
  /** Visible outside its file/module/package according to the language's rules. */
  readonly exported: boolean
  /** Declaration header without the body, whitespace collapsed. */
  readonly signature: string
  /** Doc comment or docstring attached to the declaration. */
  readonly doc: string | null
}

export const ImportKind = Schema.Literals(["import", "reexport", "dynamic", "require", "using", "static", "from"])
export type ImportKind = typeof ImportKind.Type

/** An import as written in the source, before resolution. */
export interface RawImport {
  /** Module specifier, package path, namespace or Java/Python dotted name (`.*` for wildcards). */
  readonly specifier: string
  readonly kind: ImportKind
  readonly line: number
  /** Imported names when the syntax lists them (ES named imports, Python `from x import a, b`). */
  readonly names: ReadonlyArray<string>
}

export interface FileAnalysis {
  readonly grammar: GrammarId
  readonly symbols: ReadonlyArray<CodeSymbol>
  readonly imports: ReadonlyArray<RawImport>
  /** Java package or Go package name declared by the file. */
  readonly packageName: string | null
  /** Number of syntax error nodes: the file is still analyzed, but results may be partial. */
  readonly parseErrors: number
}
