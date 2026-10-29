import {
  Analysis,
  DependencyOverview,
  FileAnalysisView,
  Job,
  SnapshotId,
  SymbolKind,
  SymbolPage
} from "@code-to-rag/core"
import { createServerFn } from "@tanstack/react-start"
import { Effect, Schema } from "effect"
import { authMiddleware } from "@/server/middleware"
import { runEffect } from "@/server/run.server"

const SYMBOL_PAGE_SIZE = 100

const encodeSymbolPage = Schema.encodeSync(SymbolPage)
const encodeFileAnalysis = Schema.encodeSync(FileAnalysisView)
const encodeOverview = Schema.encodeSync(DependencyOverview)
const encodeJob = Schema.encodeSync(Job)

const validate = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
  Schema.toStandardSchemaV1(schema)

export const listSymbols = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(
    validate(
      Schema.Struct({
        snapshotId: SnapshotId,
        search: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
        kind: Schema.optional(SymbolKind),
        exportedOnly: Schema.optional(Schema.Boolean),
        offset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))
      })
    )
  )
  .handler(({ data }) =>
    runEffect(
      Analysis.listSymbols(data.snapshotId, {
        search: data.search,
        kind: data.kind,
        exportedOnly: data.exportedOnly ?? false,
        limit: SYMBOL_PAGE_SIZE,
        offset: data.offset ?? 0
      }).pipe(Effect.map(encodeSymbolPage))
    )
  )

export const getFileAnalysis = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(validate(Schema.Struct({ snapshotId: SnapshotId, path: Schema.String.check(Schema.isMaxLength(4096)) })))
  .handler(({ data }) =>
    runEffect(Analysis.getFileAnalysis(data.snapshotId, data.path).pipe(Effect.map(encodeFileAnalysis)))
  )

export const getDependencyOverview = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(validate(Schema.Struct({ snapshotId: SnapshotId })))
  .handler(({ data }) => runEffect(Analysis.getDependencyOverview(data.snapshotId).pipe(Effect.map(encodeOverview))))

export const reanalyze = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(validate(Schema.Struct({ snapshotId: SnapshotId })))
  .handler(({ data }) => runEffect(Analysis.requestAnalysis(data.snapshotId).pipe(Effect.map(encodeJob))))
