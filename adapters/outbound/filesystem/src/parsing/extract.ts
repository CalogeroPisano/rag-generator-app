import type { Node, Query, Tree } from "web-tree-sitter"
import type { GrammarId } from "./grammars.ts"
import type { CodeSymbol, FileAnalysis, ImportKind, RawImport, SymbolKind } from "@code-to-rag/core/outbound"

const MAX_SIGNATURE = 300
const MAX_DOC = 2000

interface Definition {
  readonly node: Node
  readonly name: string
  readonly kind: SymbolKind
  readonly patternIndex: number
  /** Range used for containment; differs from the node only for C# file-scoped namespaces. */
  readonly startIndex: number
  readonly endIndex: number
}

const isEcmascript = (grammar: GrammarId) => grammar === "typescript" || grammar === "tsx" || grammar === "javascript"

const collapse = (text: string, max: number) => {
  const collapsed = text.replace(/\s+/g, " ").trim()
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed
}

/** Declaration header: the node text up to its body (or its first line when it has no body). */
const signatureOf = (node: Node): string => {
  const body = node.childForFieldName("body")
  const text =
    body !== null && body.startIndex > node.startIndex
      ? node.text.slice(0, body.startIndex - node.startIndex)
      : (node.text.split("\n")[0] ?? "")
  return collapse(text, MAX_SIGNATURE)
}

/** The statement that carries comments and modifiers: export wrappers, declarations, decorators. */
const outerNode = (node: Node): Node => {
  let current = node
  for (;;) {
    const parent = current.parent
    if (parent === null) return current
    const wraps =
      parent.type === "export_statement" ||
      parent.type === "decorated_definition" ||
      parent.type === "lexical_declaration" ||
      parent.type === "variable_declaration" ||
      parent.type === "var_declaration" ||
      parent.type === "const_declaration" ||
      parent.type === "type_declaration" ||
      (parent.type === "field_declaration" && current.type === "variable_declarator")
    if (!wraps) return current
    current = parent
  }
}

const isComment = (node: Node) =>
  node.type === "comment" || node.type === "line_comment" || node.type === "block_comment"

const docOf = (node: Node, grammar: GrammarId): string | null => {
  if (grammar === "python") {
    const first = node.childForFieldName("body")?.namedChild(0)
    if (first?.type === "expression_statement" && first.namedChild(0)?.type === "string") {
      return collapse(first.namedChild(0)?.text ?? "", MAX_DOC)
    }
  }
  const comments: Array<string> = []
  let anchor = outerNode(node)
  let previous = anchor.previousNamedSibling
  while (previous !== null && isComment(previous) && previous.endPosition.row >= anchor.startPosition.row - 1) {
    comments.unshift(previous.text)
    anchor = previous
    previous = previous.previousNamedSibling
  }
  return comments.length === 0 ? null : collapse(comments.join("\n"), MAX_DOC).slice(0, MAX_DOC)
}

const modifiersText = (node: Node): string =>
  node.namedChildren
    .filter((child) => child.type === "modifiers" || child.type === "modifier")
    .map((child) => child.text)
    .join(" ")

const isTopLevelStatement = (statement: Node | null) => {
  if (statement === null) return false
  const parent = statement.parent
  if (parent === null) return false
  if (parent.type === "program" || parent.type === "source_file" || parent.type === "module") return true
  return parent.type === "export_statement" && parent.parent?.type === "program"
}

/** Filters out declarations that are noise for a functional map (locals, object-literal methods…). */
const isRelevant = (definition: Definition, grammar: GrammarId): boolean => {
  const { node, kind } = definition
  if (isEcmascript(grammar)) {
    if (node.type === "variable_declarator") return isTopLevelStatement(node.parent)
    if (node.type === "method_definition") return node.parent?.type === "class_body"
    if (node.type === "method_signature") return node.parent?.type === "interface_body"
    return true
  }
  if (grammar === "go" && (kind === "variable" || kind === "constant")) {
    let declaration = node.parent
    while (declaration !== null && declaration.type !== "var_declaration" && declaration.type !== "const_declaration") {
      declaration = declaration.parent
    }
    return declaration?.parent?.type === "source_file"
  }
  return true
}

const isUpperCaseConstant = (name: string) => /^[A-Z][A-Z0-9_]*$/.test(name) && /[A-Z]/.test(name)

const isExported = (definition: Definition, container: Definition | undefined, grammar: GrammarId): boolean => {
  const { node, name } = definition
  switch (grammar) {
    case "typescript":
    case "tsx":
    case "javascript": {
      if (container !== undefined && container.kind !== "namespace" && container.kind !== "module") {
        if (name.startsWith("#")) return false
        const accessibility = node.namedChildren.find((child) => child.type === "accessibility_modifier")?.text
        return accessibility !== "private" && accessibility !== "protected"
      }
      return outerNode(node).type === "export_statement" || node.parent?.type === "export_statement"
    }
    case "java":
    case "csharp": {
      if (definition.kind === "namespace") return true
      const modifiers = modifiersText(node)
      if (/\bpublic\b/.test(modifiers)) return true
      // Interface members are public unless stated otherwise.
      return container?.kind === "interface" && !/\bprivate\b/.test(modifiers)
    }
    case "go":
      return /^[A-Z]/.test(name)
    case "python":
      return !name.startsWith("_") || (name.startsWith("__") && name.endsWith("__"))
  }
}

/** Go methods belong to their receiver type, which is declared outside the method. */
const goReceiverType = (node: Node): string | undefined => {
  const receiver = node.childForFieldName("receiver")
  const type = receiver?.descendantsOfType("type_identifier")[0]
  return type?.text
}

export const extractSymbols = (tree: Tree, definitionsQuery: Query, grammar: GrammarId): Array<CodeSymbol> => {
  const root = tree.rootNode
  const byNode = new Map<string, Definition>()
  for (const match of definitionsQuery.matches(root)) {
    const definitionCapture = match.captures.find((capture) => capture.name.startsWith("definition."))
    const nameCapture = match.captures.find((capture) => capture.name === "name")
    if (definitionCapture === undefined || nameCapture === undefined) continue
    const node = definitionCapture.node
    const key = `${node.id}:${nameCapture.node.text}`
    const existing = byNode.get(key)
    if (existing !== undefined && existing.patternIndex <= match.patternIndex) continue
    const fileScoped = node.type === "file_scoped_namespace_declaration"
    byNode.set(key, {
      node,
      name: nameCapture.node.text,
      kind: definitionCapture.name.slice("definition.".length) as SymbolKind,
      patternIndex: match.patternIndex,
      startIndex: node.startIndex,
      endIndex: fileScoped ? root.endIndex : node.endIndex
    })
  }

  const definitions = [...byNode.values()]
    .filter((definition) => isRelevant(definition, grammar))
    .sort((a, b) => a.startIndex - b.startIndex || b.endIndex - a.endIndex)

  const symbols: Array<CodeSymbol> = []
  const stack: Array<{ definition: Definition; qualifiedName: string; kind: SymbolKind }> = []
  const typeNames = new Map<string, string>()

  for (const definition of definitions) {
    while (stack.length > 0 && stack[stack.length - 1]!.definition.endIndex <= definition.startIndex) stack.pop()
    let parent = stack.at(-1)

    let kind = definition.kind
    if (grammar === "python" && kind === "function" && parent !== undefined) {
      // Nested functions are implementation details; functions in a class are methods.
      if (parent.kind !== "class") continue
      kind = definition.name === "__init__" ? "constructor" : "method"
    }
    if (isEcmascript(grammar) && kind === "method" && definition.name === "constructor") kind = "constructor"
    if ((kind === "variable" || kind === "field") && isUpperCaseConstant(definition.name)) kind = "constant"
    if (kind === "field" && (grammar === "java" || grammar === "csharp")) {
      const modifiers = modifiersText(definition.node)
      if (/\bconst\b/.test(modifiers) || (/\bstatic\b/.test(modifiers) && /\bfinal\b/.test(modifiers)))
        kind = "constant"
    }

    let container = parent?.qualifiedName ?? null
    if (grammar === "go" && kind === "method") {
      const receiver = goReceiverType(definition.node)
      if (receiver !== undefined) container = typeNames.get(receiver) ?? receiver
      parent = undefined
    }

    const qualifiedName = container === null ? definition.name : `${container}.${definition.name}`
    const symbol: CodeSymbol = {
      kind,
      name: definition.name,
      qualifiedName,
      container,
      startLine: definition.node.startPosition.row + 1,
      endLine: definition.node.endPosition.row + 1,
      exported: isExported(definition, parent?.definition, grammar),
      signature: signatureOf(definition.node),
      doc: docOf(definition.node, grammar)
    }
    symbols.push(symbol)
    if (kind === "struct" || kind === "type" || kind === "interface") typeNames.set(definition.name, qualifiedName)
    stack.push({ definition, qualifiedName, kind })
  }
  return symbols
}

const specifierNames = (list: Node): Array<string> =>
  list.namedChildren.flatMap((specifier) => {
    const name = specifier.childForFieldName("name")?.text
    return name === undefined ? [] : [name]
  })

/** Names brought in by an ES import/re-export: `default`, `*` or the listed specifiers. */
const ecmascriptNames = (statement: Node): Array<string> => {
  const exportClause = statement.namedChildren.find((child) => child.type === "export_clause")
  if (exportClause !== undefined) return specifierNames(exportClause)
  const importClause = statement.namedChildren.find((child) => child.type === "import_clause")
  if (importClause === undefined) return statement.type === "export_statement" ? ["*"] : []
  return importClause.namedChildren.flatMap((child) => {
    if (child.type === "identifier") return ["default"]
    if (child.type === "namespace_import") return ["*"]
    if (child.type === "named_imports") return specifierNames(child)
    return []
  })
}

export const extractImports = (tree: Tree, importsQuery: Query, grammar: GrammarId): Array<RawImport> => {
  const imports: Array<RawImport> = []
  const seen = new Set<string>()
  const push = (entry: RawImport) => {
    const key = `${entry.kind}|${entry.specifier}|${entry.line}`
    if (seen.has(key) || entry.specifier.length === 0) return
    seen.add(key)
    imports.push(entry)
  }

  for (const match of importsQuery.matches(tree.rootNode)) {
    const statementCapture = match.captures.find((capture) => capture.name.startsWith("import."))
    const source = match.captures.find((capture) => capture.name === "source")?.node
    if (statementCapture === undefined || source === undefined) continue
    const statement = statementCapture.node
    let kind = statementCapture.name.slice("import.".length) as ImportKind
    const line = statement.startPosition.row + 1

    switch (grammar) {
      case "typescript":
      case "tsx":
      case "javascript":
        push({
          specifier: source.text,
          kind,
          line,
          names: kind === "import" || kind === "reexport" ? ecmascriptNames(statement) : []
        })
        break
      case "java": {
        if (/^import\s+static\b/.test(statement.text)) kind = "static"
        const wildcard = statement.namedChildren.some((child) => child.type === "asterisk")
        push({ specifier: wildcard ? `${source.text}.*` : source.text, kind, line, names: [] })
        break
      }
      case "csharp": {
        // `using Alias = A.B;`: the alias identifier is not the imported namespace.
        if (statement.childForFieldName("name")?.id === source.id) break
        if (/^(global\s+)?using\s+static\b/.test(statement.text)) kind = "static"
        push({ specifier: source.text, kind, line, names: [] })
        break
      }
      case "go":
        push({ specifier: source.text, kind, line, names: [] })
        break
      case "python": {
        if (kind === "from") {
          const names = statement
            .childrenForFieldName("name")
            .map((name) => (name.type === "aliased_import" ? (name.childForFieldName("name")?.text ?? "") : name.text))
          if (statement.namedChildren.some((child) => child.type === "wildcard_import")) names.push("*")
          push({ specifier: source.text.replace(/\s+/g, ""), kind, line, names })
        } else {
          push({ specifier: source.text, kind, line, names: [] })
        }
        break
      }
    }
  }
  return imports
}

const packageNameOf = (tree: Tree, grammar: GrammarId): string | null => {
  const root = tree.rootNode
  if (grammar === "java") {
    const declaration = root.namedChildren.find((child) => child.type === "package_declaration")
    return (
      declaration?.namedChildren.find((child) => child.type !== "annotation" && child.type !== "marker_annotation")
        ?.text ?? null
    )
  }
  if (grammar === "go") {
    return root.namedChildren.find((child) => child.type === "package_clause")?.namedChild(0)?.text ?? null
  }
  return null
}

export const analyzeTree = (
  tree: Tree,
  grammar: GrammarId,
  queries: { readonly definitions: Query; readonly imports: Query }
): FileAnalysis => ({
  grammar,
  symbols: extractSymbols(tree, queries.definitions, grammar),
  imports: extractImports(tree, queries.imports, grammar),
  packageName: packageNameOf(tree, grammar),
  parseErrors: tree.rootNode.hasError ? Math.max(1, tree.rootNode.descendantsOfType("ERROR").length) : 0
})
