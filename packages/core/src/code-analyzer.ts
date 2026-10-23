import { type CodeAnalyzer as Analyzer, makeCodeAnalyzer } from "@code-to-rag/analysis"
import { Context, Layer } from "effect"
import { AppConfig } from "./config.ts"

/** Tree-sitter based analyzer, loaded once per process (grammars stay in wasm memory). */
export class CodeAnalyzer extends Context.Service<CodeAnalyzer, Analyzer>()("code-to-rag/core/CodeAnalyzer") {
  static readonly layer = Layer.effect(
    CodeAnalyzer,
    AppConfig.use((config) => makeCodeAnalyzer(config.grammarsDir))
  )
}
