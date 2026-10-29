import { ImportKind } from "@code-to-rag/core/outbound"
import { AnalysisRepository, NotFoundError } from "@code-to-rag/core/outbound"
import { and, asc, count, desc, eq, gt, ilike, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm"
import { Effect, Layer, Schema } from "effect"
import * as posix from "node:path/posix"
import { Database, query } from "./client.ts"
import { decodeFileAnalysis, decodeOverview, decodeSymbolPage } from "./rows.ts"
import { fileDependency, snapshot, sourceBlob, sourceFile, symbol } from "./schema/app.ts"

/** Rows per INSERT: well below the 65 535 bind parameters of a Postgres statement. */
const INSERT_CHUNK = 1000

const chunks = <A>(items: ReadonlyArray<A>, size: number): Array<ReadonlyArray<A>> => {
  const result: Array<ReadonlyArray<A>> = []
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size))
  return result
}

const decodeImportKind = Schema.decodeUnknownSync(ImportKind)

const CSHARP_TYPE_KINDS = ["class", "interface", "struct", "record", "enum"]

export const AnalysisRepositoryLive = Layer.effect(
  AnalysisRepository,
  Effect.gen(function* () {
    const { db } = yield* Database

    const fileByPath = (snapshotId: string, path: string) =>
      query("analysis.fileByPath", () =>
        db
          .select({ id: sourceFile.id })
          .from(sourceFile)
          .where(and(eq(sourceFile.snapshotId, snapshotId), eq(sourceFile.path, path)))
      ).pipe(Effect.map((rows) => rows[0]))

    return AnalysisRepository.of({
      setStatus: (id, status) =>
        query("analysis.setStatus", () =>
          db.update(snapshot).set({ analysisStatus: status }).where(eq(snapshot.id, id))
        ).pipe(Effect.asVoid),

      clear: (id) =>
        query("analysis.clear", () =>
          db.transaction(async (tx) => {
            await tx.delete(fileDependency).where(eq(fileDependency.snapshotId, id))
            await tx.delete(symbol).where(eq(symbol.snapshotId, id))
            await tx
              .update(sourceFile)
              .set({ packageName: null, parseErrors: null })
              .where(eq(sourceFile.snapshotId, id))
            await tx.update(snapshot).set({ symbolCount: 0, dependencyCount: 0 }).where(eq(snapshot.id, id))
          })
        ),

      filesToAnalyze: (id, afterFileId, limit, languages) =>
        query("analysis.filesToAnalyze", () =>
          db
            .select({ fileId: sourceFile.id, path: sourceFile.path, content: sourceBlob.content })
            .from(sourceFile)
            .innerJoin(sourceBlob, eq(sourceBlob.hash, sourceFile.contentHash))
            .where(
              and(
                eq(sourceFile.snapshotId, id),
                isNull(sourceFile.excludedReason),
                inArray(sourceFile.language, [...languages]),
                gt(sourceFile.id, afterFileId)
              )
            )
            .orderBy(asc(sourceFile.id))
            .limit(limit)
        ),

      saveParsed: (id, files) =>
        query("analysis.saveParsed", () =>
          db.transaction(async (tx) => {
            if (files.length === 0) return
            const values = files.map(
              (file) => sql`(${file.fileId}::bigint, ${file.packageName}::text, ${file.parseErrors}::int)`
            )
            await tx.execute(sql`
              update source_file as f
              set package_name = v.package_name, parse_errors = v.parse_errors
              from (values ${sql.join(values, sql`, `)}) as v(id, package_name, parse_errors)
              where f.id = v.id`)

            const symbols = files.flatMap((file) =>
              file.symbols.map((entry) => ({
                snapshotId: id,
                fileId: file.fileId,
                kind: entry.kind,
                name: entry.name,
                qualifiedName: entry.qualifiedName,
                container: entry.container,
                startLine: entry.startLine,
                endLine: entry.endLine,
                exported: entry.exported,
                signature: entry.signature,
                doc: entry.doc
              }))
            )
            for (const chunk of chunks(symbols, INSERT_CHUNK)) await tx.insert(symbol).values([...chunk])

            const dependencies = files.flatMap((file) =>
              file.imports.map((entry) => ({
                snapshotId: id,
                fileId: file.fileId,
                specifier: entry.specifier,
                kind: entry.kind,
                line: entry.line,
                names: [...entry.names],
                targetKind: "pending"
              }))
            )
            for (const chunk of chunks(dependencies, INSERT_CHUNK)) await tx.insert(fileDependency).values([...chunk])
          })
        ),

      resolverInput: Effect.fnUntraced(function* (id, isConfigFile) {
        const files = yield* query("analysis.resolverFiles", () =>
          db
            .select({ path: sourceFile.path, packageName: sourceFile.packageName })
            .from(sourceFile)
            .where(and(eq(sourceFile.snapshotId, id), eq(sourceFile.isDirectory, false)))
        )
        const configPaths = files.map((file) => file.path).filter(isConfigFile)
        const configFiles =
          configPaths.length === 0
            ? []
            : yield* query("analysis.resolverConfigs", () =>
                db
                  .select({ path: sourceFile.path, content: sourceBlob.content })
                  .from(sourceFile)
                  .innerJoin(sourceBlob, eq(sourceBlob.hash, sourceFile.contentHash))
                  .where(and(eq(sourceFile.snapshotId, id), inArray(sourceFile.path, configPaths)))
              )
        const csharpSymbols = yield* query("analysis.resolverCsharp", () =>
          db
            .select({ kind: symbol.kind, qualifiedName: symbol.qualifiedName, path: sourceFile.path })
            .from(symbol)
            .innerJoin(sourceFile, eq(sourceFile.id, symbol.fileId))
            .where(
              and(
                eq(symbol.snapshotId, id),
                inArray(symbol.kind, ["namespace", ...CSHARP_TYPE_KINDS]),
                sql`${sourceFile.path} like '%.cs'`
              )
            )
        )
        return {
          files,
          configFiles,
          csharpNamespaces: [
            ...new Set(csharpSymbols.filter((row) => row.kind === "namespace").map((row) => row.qualifiedName))
          ],
          csharpTypes: csharpSymbols
            .filter((row) => row.kind !== "namespace")
            .map((row) => ({ qualifiedName: row.qualifiedName, path: row.path }))
        }
      }),

      pendingDependencies: (id, afterId, limit) =>
        query("analysis.pendingDependencies", () =>
          db
            .select({
              id: fileDependency.id,
              fromPath: sourceFile.path,
              specifier: fileDependency.specifier,
              kind: fileDependency.kind,
              line: fileDependency.line,
              names: fileDependency.names
            })
            .from(fileDependency)
            .innerJoin(sourceFile, eq(sourceFile.id, fileDependency.fileId))
            .where(
              and(
                eq(fileDependency.snapshotId, id),
                eq(fileDependency.targetKind, "pending"),
                gt(fileDependency.id, afterId)
              )
            )
            .orderBy(asc(fileDependency.id))
            .limit(limit)
        ).pipe(
          Effect.map((rows) =>
            rows.map((row) => ({
              id: row.id,
              fromPath: row.fromPath,
              entry: { specifier: row.specifier, kind: decodeImportKind(row.kind), line: row.line, names: row.names }
            }))
          )
        ),

      saveTargets: (id, targets) =>
        query("analysis.saveTargets", () =>
          db.transaction(async (tx) => {
            if (targets.length === 0) return
            const filePaths = [
              ...new Set(targets.flatMap(({ target }) => (target.kind === "file" ? [target.path] : [])))
            ]
            const fileIds = new Map<string, number>()
            for (const chunk of chunks(filePaths, INSERT_CHUNK)) {
              const rows = await tx
                .select({ id: sourceFile.id, path: sourceFile.path })
                .from(sourceFile)
                .where(and(eq(sourceFile.snapshotId, id), inArray(sourceFile.path, [...chunk])))
              for (const row of rows) fileIds.set(row.path, row.id)
            }
            for (const chunk of chunks(targets, INSERT_CHUNK)) {
              const values = chunk.map(({ id: dependencyId, target }) => {
                const fileId = target.kind === "file" ? (fileIds.get(target.path) ?? null) : null
                const kind = target.kind === "file" && fileId === null ? "unresolved" : target.kind
                const path =
                  target.kind === "directory" ? target.path : target.kind === "namespace" ? target.name : null
                const external = target.kind === "external" ? target.name : null
                return sql`(${dependencyId}::bigint, ${kind}::text, ${fileId}::bigint, ${path}::text, ${external}::text)`
              })
              await tx.execute(sql`
                update file_dependency as d
                set target_kind = v.kind, target_file_id = v.file_id, target_path = v.path, external_name = v.external
                from (values ${sql.join(values, sql`, `)}) as v(id, kind, file_id, path, external)
                where d.id = v.id`)
            }
          })
        ),

      complete: (id, analyzerVersion) =>
        query("analysis.complete", () =>
          db
            .update(snapshot)
            .set({
              analysisStatus: "ready",
              analyzerVersion,
              analyzedAt: new Date(),
              symbolCount: sql`(select count(*) from ${symbol} where ${symbol.snapshotId} = ${id})`,
              dependencyCount: sql`(select count(*) from ${fileDependency} where ${fileDependency.snapshotId} = ${id})`
            })
            .where(eq(snapshot.id, id))
        ).pipe(Effect.asVoid),

      listSymbols: Effect.fnUntraced(function* (id, request) {
        const filters: Array<SQL | undefined> = [eq(symbol.snapshotId, id)]
        if (request.search !== undefined && request.search.trim() !== "") {
          const pattern = `%${request.search.trim().replace(/[\\%_]/g, (char) => `\\${char}`)}%`
          filters.push(or(ilike(symbol.name, pattern), ilike(symbol.qualifiedName, pattern)))
        }
        if (request.kind !== undefined) filters.push(eq(symbol.kind, request.kind))
        if (request.exportedOnly) filters.push(eq(symbol.exported, true))
        const where = and(...filters)

        const [rows, totals] = yield* Effect.all([
          query("analysis.listSymbols", () =>
            db
              .select({
                path: sourceFile.path,
                kind: symbol.kind,
                name: symbol.name,
                qualifiedName: symbol.qualifiedName,
                container: symbol.container,
                startLine: symbol.startLine,
                endLine: symbol.endLine,
                exported: symbol.exported,
                signature: symbol.signature,
                doc: symbol.doc
              })
              .from(symbol)
              .innerJoin(sourceFile, eq(sourceFile.id, symbol.fileId))
              .where(where)
              .orderBy(asc(symbol.name), asc(sourceFile.path), asc(symbol.startLine))
              .limit(request.limit)
              .offset(request.offset)
          ),
          query("analysis.countSymbols", () => db.select({ total: count() }).from(symbol).where(where))
        ])
        return yield* decodeSymbolPage({ items: rows, total: totals[0]?.total ?? 0 })
      }),

      fileAnalysis: Effect.fnUntraced(function* (id, path) {
        const file = yield* fileByPath(id, path)
        if (file === undefined) return yield* new NotFoundError({ entity: "file", id: path })

        const symbols = yield* query("analysis.fileSymbols", () =>
          db
            .select({
              kind: symbol.kind,
              name: symbol.name,
              qualifiedName: symbol.qualifiedName,
              container: symbol.container,
              startLine: symbol.startLine,
              endLine: symbol.endLine,
              exported: symbol.exported,
              signature: symbol.signature,
              doc: symbol.doc
            })
            .from(symbol)
            .where(eq(symbol.fileId, file.id))
            .orderBy(asc(symbol.startLine))
        )

        const target = sql<string | null>`coalesce(target_file.path, ${fileDependency.targetPath})`
        const imports = yield* query("analysis.fileImports", () =>
          db
            .select({
              specifier: fileDependency.specifier,
              kind: fileDependency.kind,
              line: fileDependency.line,
              names: fileDependency.names,
              targetKind: fileDependency.targetKind,
              target,
              externalName: fileDependency.externalName
            })
            .from(fileDependency)
            .leftJoin(sql`${sourceFile} as target_file`, sql`target_file.id = ${fileDependency.targetFileId}`)
            .where(eq(fileDependency.fileId, file.id))
            .orderBy(asc(fileDependency.line))
        )

        // Importers of this file, of its directory (Go packages, Java `pkg.*`) or of
        // the namespaces it declares (C#).
        const directory = posix.dirname(path) === "." ? "" : posix.dirname(path)
        const namespaces = symbols.filter((entry) => entry.kind === "namespace").map((entry) => entry.qualifiedName)
        const importedBy = yield* query("analysis.fileImporters", () =>
          db
            .selectDistinctOn([sourceFile.path], {
              path: sourceFile.path,
              line: fileDependency.line,
              specifier: fileDependency.specifier
            })
            .from(fileDependency)
            .innerJoin(sourceFile, eq(sourceFile.id, fileDependency.fileId))
            .where(
              and(
                eq(fileDependency.snapshotId, id),
                sql`${fileDependency.fileId} <> ${file.id}`,
                or(
                  eq(fileDependency.targetFileId, file.id),
                  and(eq(fileDependency.targetKind, "directory"), eq(fileDependency.targetPath, directory)),
                  namespaces.length === 0
                    ? undefined
                    : and(eq(fileDependency.targetKind, "namespace"), inArray(fileDependency.targetPath, namespaces))
                )
              )
            )
            .orderBy(asc(sourceFile.path), asc(fileDependency.line))
        )

        return yield* decodeFileAnalysis({
          path,
          symbols: symbols.map((entry) => ({ ...entry, path })),
          imports,
          importedBy
        })
      }),

      overview: Effect.fnUntraced(function* (id) {
        const [externals, hubs, byTargetKind, languages] = yield* Effect.all([
          query("analysis.externals", () =>
            db
              .select({
                name: sql<string>`${fileDependency.externalName}`,
                files: sql<number>`count(distinct ${fileDependency.fileId})`.mapWith(Number)
              })
              .from(fileDependency)
              .where(and(eq(fileDependency.snapshotId, id), eq(fileDependency.targetKind, "external")))
              .groupBy(fileDependency.externalName)
              .orderBy(desc(sql`count(distinct ${fileDependency.fileId})`), asc(fileDependency.externalName))
              .limit(50)
          ),
          query("analysis.hubs", () =>
            db.execute<{ path: string; importedBy: number; imports: number }>(sql`
              select f.path,
                     count(distinct d.file_id)::int as "importedBy",
                     (select count(*)::int from ${fileDependency} o where o.file_id = f.id) as imports
              from ${fileDependency} d
              join ${sourceFile} f on f.id = d.target_file_id
              where d.snapshot_id = ${id}
              group by f.id, f.path
              order by "importedBy" desc, f.path
              limit 20`)
          ),
          query("analysis.byTargetKind", () =>
            db
              .select({ targetKind: fileDependency.targetKind, count: count() })
              .from(fileDependency)
              .where(eq(fileDependency.snapshotId, id))
              .groupBy(fileDependency.targetKind)
          ),
          query("analysis.languages", () =>
            db
              .select({
                language: sourceFile.language,
                files: count(),
                symbols:
                  sql<number>`coalesce(sum((select count(*) from ${symbol} s where s.file_id = ${sourceFile.id})), 0)`.mapWith(
                    Number
                  )
              })
              .from(sourceFile)
              .where(and(eq(sourceFile.snapshotId, id), isNotNull(sourceFile.parseErrors)))
              .groupBy(sourceFile.language)
              .orderBy(desc(count()))
          )
        ])
        return yield* decodeOverview({ externals, hubs: hubs.rows, byTargetKind, languages })
      })
    })
  })
)
