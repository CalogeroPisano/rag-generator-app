import { Effect, Schema } from "effect"
import { Language, Parser, Query } from "web-tree-sitter"
import { analyzeTree } from "./extract.ts"
import { type GrammarId, grammarForPath, grammarIds, resolveWasmFiles } from "./grammars.ts"
import type { FileAnalysis } from "./model.ts"
import { grammarQueries } from "./queries.ts"

/** The tree-sitter runtime or a grammar could not be loaded (missing or incompatible wasm). */
export class AnalyzerInitError extends Schema.TaggedError<AnalyzerInitError>()("AnalyzerInitError", {
  message: Schema.String
}) {}

export interface CodeAnalyzer {
  /** Grammars available; files of other languages are not analyzed. */
  readonly grammars: ReadonlyArray<GrammarId>
  /** Parses one file. `undefined` when no grammar handles its extension. Synchronous and CPU-bound. */
  analyze(path: string, content: string): FileAnalysis | undefined
}

interface LoadedGrammar {
  readonly parser: Parser
  readonly definitions: Query
  readonly imports: Query
}

// Parser.init loads the wasm runtime once per process.
let runtimeReady: Promise<void> | undefined

/**
 * Loads the tree-sitter runtime, every grammar and its queries. Resources are
 * freed when the surrounding scope closes.
 */
export const makeCodeAnalyzer = Effect.fn("makeCodeAnalyzer")(function* (grammarsDir: string | undefined) {
  const files = yield* Effect.try({
    try: () => resolveWasmFiles(grammarsDir),
    catch: () => new AnalyzerInitError({ message: "Tree-sitter wasm files not found" })
  })
  yield* Effect.tryPromise({
    try: () => (runtimeReady ??= Parser.init({ locateFile: () => files.runtime })),
    catch: (cause) => new AnalyzerInitError({ message: `Cannot initialize tree-sitter: ${String(cause)}` })
  })

  const loaded = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const entries = await Promise.all(
          grammarIds.map(async (id): Promise<readonly [GrammarId, LoadedGrammar]> => {
            const language = await Language.load(files.grammars[id])
            const parser = new Parser()
            parser.setLanguage(language)
            return [
              id,
              {
                parser,
                definitions: new Query(language, grammarQueries[id].definitions),
                imports: new Query(language, grammarQueries[id].imports)
              }
            ]
          })
        )
        return new Map(entries)
      },
      catch: (cause) => new AnalyzerInitError({ message: `Cannot load grammars: ${String(cause)}` })
    }),
    (grammars) =>
      Effect.sync(() => {
        for (const grammar of grammars.values()) {
          grammar.definitions.delete()
          grammar.imports.delete()
          grammar.parser.delete()
        }
      })
  )

  const analyze = (path: string, content: string): FileAnalysis | undefined => {
    const id = grammarForPath(path)
    const grammar = id === undefined ? undefined : loaded.get(id)
    if (id === undefined || grammar === undefined) return undefined
    const tree = grammar.parser.parse(content)
    if (tree === null) return { grammar: id, symbols: [], imports: [], packageName: null, parseErrors: 1 }
    try {
      return analyzeTree(tree, id, grammar)
    } finally {
      // Trees live in wasm memory: free them explicitly.
      tree.delete()
    }
  }

  return { grammars: grammarIds, analyze } satisfies CodeAnalyzer
})
