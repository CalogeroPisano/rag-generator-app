/**
 * Knowledge export (phase 7): the current version of a project as a JSONL
 * archive (zip: `manifest.json` + one file per `rag` table) or as a SQL script
 * that recreates the `rag` schema in another Postgres and replaces the
 * project's data there. Both are written while they are read, in pages, from
 * one read-only transaction.
 */
import { Effect } from "effect"
import { Zip, ZipDeflate } from "fflate"
import type { ProjectId } from "../domain.ts"
import { InvalidInputError } from "../errors.ts"
import {
  EXPORT_TABLES,
  type ExportColumn,
  type ExportReader,
  ExportRepository,
  type ExportScope,
  type ExportTable,
  JobRepository,
  ProjectRepository
} from "../ports.ts"
import {
  EXPORT_FORMAT_VERSION,
  exportFileName,
  type ExportFormat,
  type ExportManifest,
  insertStatement,
  jsonLine,
  scriptFooter,
  scriptHeader,
  tableFile
} from "./format.ts"

/** Rows per page (and per INSERT); chunks carry a vector each. */
const pageSize = (table: ExportTable) => (table === "chunk" ? 50 : 500)

export interface ExportPlan {
  readonly scope: ExportScope
  /** File name without extension. */
  readonly fileName: string
  /** An indexing job is running: chunks of some cards may be missing or outdated. */
  readonly indexing: boolean
}

/** Checks that the current version can be exported (its cards are generated and not being regenerated). */
export const prepareExport = Effect.fn("prepareExport")(function* (projectId: ProjectId, approvedOnly: boolean) {
  const { project, currentSnapshot } = yield* (yield* ProjectRepository).get(projectId)
  const active = (yield* (yield* JobRepository).active(projectId)).filter(
    (job) => job.snapshotId === currentSnapshot?.id
  )
  if (active.some((job) => job.type === "understanding" || job.type === "card")) {
    return yield* new InvalidInputError({ message: "Attendi la fine della generazione delle schede" })
  }
  if (currentSnapshot === null || currentSnapshot.understandingStatus !== "ready") {
    return yield* new InvalidInputError({ message: "Genera le schede del progetto prima di esportarle" })
  }
  return {
    scope: { projectId, snapshotId: currentSnapshot.id, approvedOnly },
    fileName: exportFileName(project.name, currentSnapshot.commitSha ?? currentSnapshot.contentHash, approvedOnly),
    indexing: active.some((job) => job.type === "indexing")
  } satisfies ExportPlan
})

interface TableInfo {
  readonly table: ExportTable
  readonly columns: ReadonlyArray<ExportColumn>
  readonly rows: number
}

const describeTables = (reader: ExportReader) =>
  Effect.forEach(EXPORT_TABLES, (table) =>
    Effect.all({ columns: reader.columns(table), rows: reader.count(table) }).pipe(
      Effect.map(({ columns, rows }): TableInfo => ({ table, columns, rows }))
    )
  )

const text = (value: unknown) => (typeof value === "string" ? value : "")

const makeManifest = Effect.fnUntraced(function* (
  reader: ExportReader,
  scope: ExportScope,
  tables: ReadonlyArray<TableInfo>
) {
  const [snapshot] = (yield* reader.page("snapshot", null, 1)).rows
  if (snapshot === undefined) {
    return yield* new InvalidInputError({ message: "Genera le schede del progetto prima di esportarle" })
  }
  const repositoryUrl = snapshot["repository_url"]
  return {
    format: "code-to-rag-knowledge",
    formatVersion: EXPORT_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    project: {
      id: scope.projectId,
      name: text(snapshot["project_name"]),
      sourceType: text(snapshot["source_type"]),
      repositoryUrl: typeof repositoryUrl === "string" ? repositoryUrl : null
    },
    snapshot: {
      id: scope.snapshotId,
      revision: text(snapshot["revision"]),
      language: text(snapshot["language"]),
      model: text(snapshot["model"])
    },
    cards: scope.approvedOnly ? "approved-only" : "all-except-excluded",
    embeddings: yield* reader.embeddings,
    tables: tables.map((info) => ({
      name: `rag.${info.table}`,
      file: tableFile(info.table),
      rows: info.rows,
      columns: info.columns
    }))
  } satisfies ExportManifest
})

/** What the export of the plan contains: rows per table and embedding models. */
export const exportPreview = Effect.fn("exportPreview")(function* (plan: ExportPlan) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const reader = yield* (yield* ExportRepository).open(plan.scope)
      const tables = yield* describeTables(reader)
      return {
        fileName: plan.fileName,
        indexing: plan.indexing,
        rows: Object.fromEntries(tables.map((info) => [info.table, info.rows])) as Record<ExportTable, number>,
        embeddings: yield* reader.embeddings
      }
    })
  )
})

/** Pages of a table, handed to `onPage` one at a time. */
const forEachPage = <E, R>(
  reader: ExportReader,
  table: ExportTable,
  onPage: (rows: ReadonlyArray<Record<string, unknown>>) => Effect.Effect<void, E, R>
) =>
  Effect.gen(function* () {
    let after: string | number | null = null
    for (;;) {
      const page: Effect.Success<ReturnType<ExportReader["page"]>> = yield* reader.page(table, after, pageSize(table))
      if (page.rows.length > 0) yield* onPage(page.rows)
      if (page.next === null) return
      after = page.next
    }
  })

const encoder = new TextEncoder()

/**
 * Zip archive written as it is produced. fflate's `ZipDeflate` compresses synchronously: the output of every push
 * is collected and handed to `write` before the next page is read.
 */
const makeZip = <E, R>(write: (bytes: Uint8Array) => Effect.Effect<void, E, R>) => {
  const output: Array<Uint8Array> = []
  let failure: Error | null = null
  const zip = new Zip((error, data) => {
    if (error !== null) failure = error
    else output.push(data)
  })
  const flush = Effect.suspend(() => {
    if (failure !== null) return Effect.die(failure)
    const bytes = output.splice(0)
    return Effect.forEach(bytes, write, { discard: true })
  })
  const mtime = new Date()
  return {
    file: (name: string) => {
      const entry = new ZipDeflate(name, { level: 6 })
      entry.mtime = mtime
      zip.add(entry)
      return {
        push: (content: string) => Effect.suspend(() => (entry.push(encoder.encode(content)), flush)),
        end: Effect.suspend(() => (entry.push(new Uint8Array(0), true), flush))
      }
    },
    end: Effect.suspend(() => (zip.end(), flush))
  }
}

/** Writes the export of the plan in the given format; `write` receives the bytes in order. */
export const writeExport = Effect.fn("writeExport")(function* <E, R>(
  plan: ExportPlan,
  format: ExportFormat,
  write: (bytes: Uint8Array) => Effect.Effect<void, E, R>
) {
  yield* Effect.scoped(
    Effect.gen(function* () {
      const reader = yield* (yield* ExportRepository).open(plan.scope)
      const tables = yield* describeTables(reader)
      const manifest = yield* makeManifest(reader, plan.scope, tables)

      if (format === "sql") {
        yield* write(encoder.encode(scriptHeader(manifest, yield* reader.schemaStatements)))
        for (const info of tables) {
          yield* forEachPage(reader, info.table, (rows) =>
            write(encoder.encode(insertStatement(info.table, info.columns, rows)))
          )
        }
        yield* write(encoder.encode(scriptFooter))
      } else {
        const zip = makeZip(write)
        const manifestFile = zip.file("manifest.json")
        yield* manifestFile.push(`${JSON.stringify(manifest, null, 2)}\n`)
        yield* manifestFile.end
        for (const info of tables) {
          const file = zip.file(tableFile(info.table))
          yield* forEachPage(reader, info.table, (rows) =>
            file.push(rows.map((row) => jsonLine(info.columns, row)).join(""))
          )
          yield* file.end
        }
        yield* zip.end
      }
      yield* Effect.logInfo("Knowledge exported").pipe(
        Effect.annotateLogs({ projectId: plan.scope.projectId, snapshotId: plan.scope.snapshotId, format })
      )
    })
  )
})
