import { Context } from "effect"
import type { DependencyTarget, FileAnalysis, RawImport, ResolverInput } from "../../domain/code.ts"

/** Static analysis of source files (implemented with tree-sitter by `@code-to-rag/filesystem`). */
export class CodeAnalyzer extends Context.Service<
  CodeAnalyzer,
  {
    /** Version of the extraction and resolution rules, stored with every analysis. */
    readonly version: string
    /** Parses one file. `undefined` when no grammar handles its extension. Synchronous and CPU-bound. */
    analyze(path: string, content: string): FileAnalysis | undefined
    /** Configuration files the resolver needs (tsconfig, jsconfig, package.json, go.mod). */
    isResolverConfigFile(path: string): boolean
    /** Resolves imports against the files of a snapshot; unresolved for files no grammar handles. */
    resolver(input: ResolverInput): (fromPath: string, entry: RawImport) => DependencyTarget
  }
>()("code-to-rag/core/CodeAnalyzer") {}
