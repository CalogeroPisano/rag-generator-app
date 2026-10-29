import {
  DatabaseError,
  EXPORT_TABLES,
  type ExportColumn,
  type ExportReader,
  ExportRepository,
  type ExportScope,
  type ExportTable
} from "@code-to-rag/core"
import { Effect, Layer } from "effect"
import type pg from "pg"
import { Database } from "./client.ts"

/** Column used to page through a table (unique, stable order) and its type. */
const keyOf = (table: ExportTable) => {
  switch (table) {
    case "card_verification":
      return { column: "card_id", type: "uuid" }
    case "file_summary":
    case "symbol_summary":
    case "module_summary":
    case "card_reference":
    case "chunk":
    case "test_result":
      return { column: "id", type: "bigint" }
    default:
      return { column: "id", type: "uuid" }
  }
}

/** Cards in scope, as a condition on the alias `a`. */
const cardInScope = (a: string) =>
  `${a}.snapshot_id = {snapshot} and (case when {approved} then ${a}.status = 'approved' else ${a}.status <> 'excluded' end)`

/** Test runs in scope (alias `a`): when the export has approved cards only, runs over approved cards only. */
const runInScope = (a: string) =>
  `${a}.snapshot_id = {snapshot} and ${a}.status <> 'running' and (not {approved} or ${a}.approved_only)`

const cardOf = (condition: string) => `exists (select 1 from rag.card c where ${condition} and ${cardInScope("c")})`

/**
 * Rows of a table in scope, as a condition on the alias `t`. Features, corrections and test questions follow the
 * exported cards.
 */
const inScope: Record<ExportTable, string> = {
  snapshot: `t.id = {snapshot}`,
  file_summary: `t.snapshot_id = {snapshot}`,
  symbol_summary: `t.snapshot_id = {snapshot}`,
  module_summary: `t.snapshot_id = {snapshot}`,
  feature: cardOf("c.feature_id = t.id"),
  card: cardInScope("t"),
  card_reference: cardOf("c.id = t.card_id"),
  card_verification: cardOf("c.id = t.card_id"),
  correction: `t.project_id = {project} and ${cardOf("c.feature_id = t.feature_id")}`,
  // Only chunks of the current card versions: older ones are ignored by searches.
  chunk: cardOf("c.id = t.card_id and c.version = t.card_version"),
  test_question: `t.project_id = {project} and ${cardOf("c.feature_id = t.feature_id")}`,
  test_run: runInScope("t"),
  test_result: `exists (select 1 from rag.test_run r where r.id = t.run_id and ${runInScope("r")})`
}

interface CatalogColumn {
  readonly table: string
  readonly name: string
  readonly type: string
  readonly notNull: boolean
  readonly defaultValue: string | null
  readonly generated: string
}

type Parameter = "snapshot" | "approved" | "project" | "after"

/** Replaces `{name}` placeholders with typed positional parameters (unused ones are not sent: Postgres rejects them). */
const bind = (text: string, values: Record<Parameter, unknown>) => {
  const used: Array<Parameter> = []
  const types: Record<Parameter, string> = { snapshot: "uuid", approved: "boolean", project: "uuid", after: "text" }
  const bound = text.replace(/\{(snapshot|approved|project|after)\}/g, (_, name: Parameter) => {
    if (!used.includes(name)) used.push(name)
    return `$${used.indexOf(name) + 1}::${types[name]}`
  })
  return { text: bound, values: used.map((name) => values[name]) }
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`

/** Serial columns (default from their own sequence) are recreated as `serial`/`bigserial`. */
const serialType = (column: CatalogColumn) => {
  if (column.defaultValue === null || !column.defaultValue.startsWith("nextval(")) return undefined
  return column.type === "bigint" ? "bigserial" : column.type === "integer" ? "serial" : undefined
}

const columnDefinition = (column: CatalogColumn) => {
  const serial = serialType(column)
  const parts = [quote(column.name), serial ?? column.type]
  if (column.generated === "s") parts.push(`GENERATED ALWAYS AS (${column.defaultValue}) STORED`)
  else if (serial === undefined && column.defaultValue !== null) parts.push(`DEFAULT ${column.defaultValue}`)
  if (column.notNull && serial === undefined) parts.push("NOT NULL")
  return parts.join(" ")
}

/** Reads the export inside a read-only, repeatable-read transaction on one pooled connection. */
const makeReader = Effect.fnUntraced(function* (client: pg.PoolClient, scope: ExportScope) {
  const run = <Row extends pg.QueryResultRow>(operation: string, text: string, values: ReadonlyArray<unknown> = []) =>
    Effect.tryPromise({
      try: () => client.query<Row>(text, [...values]),
      catch: (cause) => new DatabaseError({ operation, cause })
    }).pipe(Effect.map((result) => result.rows))
  /** A query on the rows in scope (`{snapshot}`, `{approved}`, `{project}` and the page cursor `{after}`). */
  const scoped = <Row extends pg.QueryResultRow>(operation: string, text: string, after: string | null = null) => {
    const query = bind(text, {
      snapshot: scope.snapshotId,
      approved: scope.approvedOnly,
      project: scope.projectId,
      after
    })
    return run<Row>(operation, query.text, query.values)
  }

  const catalog = yield* run<CatalogColumn>(
    "export.catalog",
    `select c.relname as "table", a.attname as name, format_type(a.atttypid, a.atttypmod) as type,
            a.attnotnull as "notNull", pg_get_expr(d.adbin, d.adrelid) as "defaultValue",
            a.attgenerated as generated
       from pg_attribute a
       join pg_class c on c.oid = a.attrelid
       left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where c.relnamespace = 'rag'::regnamespace and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
      order by c.relname, a.attnum`
  )

  const columns = (table: ExportTable) =>
    Effect.succeed(
      catalog
        // Serial ids would collide with rows already in the target database; generated columns are computed there.
        .filter((column) => column.table === table && column.generated === "" && serialType(column) === undefined)
        .map((column): ExportColumn => ({ name: column.name, type: column.type }))
    )

  const reader: ExportReader = {
    schemaStatements: Effect.gen(function* () {
      const tableColumns = catalog
      const constraints = yield* run<{ table: string; name: string; definition: string }>(
        "export.constraints",
        `select c.conrelid::regclass::text as "table", c.conname as name, pg_get_constraintdef(c.oid) as definition
           from pg_constraint c
          where c.connamespace = 'rag'::regnamespace and c.contype in ('p', 'f', 'u', 'c')
          order by c.conrelid, c.contype <> 'p', c.conname`
      )
      const indexes = yield* run<{ table: string; definition: string }>(
        "export.indexes",
        `select i.indrelid::regclass::text as "table", pg_get_indexdef(i.indexrelid) as definition
           from pg_index i
           join pg_class c on c.oid = i.indexrelid
          where c.relnamespace = 'rag'::regnamespace
            and not exists (select 1 from pg_constraint k where k.conindid = i.indexrelid)
          order by c.relname`
      )
      const known = new Set<string>(EXPORT_TABLES)
      const unknown = [...new Set(tableColumns.map((column) => column.table))].filter((table) => !known.has(table))
      if (unknown.length > 0) {
        return yield* new DatabaseError({
          operation: "export.schema",
          cause: new Error(`Unknown rag tables: ${unknown.join(", ")}`)
        })
      }
      return EXPORT_TABLES.flatMap((table) => {
        const qualified = `rag.${table}`
        const definitions = [
          ...tableColumns.filter((column) => column.table === table).map(columnDefinition),
          ...constraints
            .filter((constraint) => constraint.table === qualified)
            .map((constraint) => `CONSTRAINT ${quote(constraint.name)} ${constraint.definition}`)
        ]
        return [
          `CREATE TABLE IF NOT EXISTS "rag".${quote(table)} (\n  ${definitions.join(",\n  ")}\n)`,
          ...indexes
            .filter((index) => index.table === qualified)
            .map((index) => index.definition.replace(/^CREATE (UNIQUE )?INDEX /, "CREATE $1INDEX IF NOT EXISTS "))
        ]
      })
    }),

    columns,

    count: (table) =>
      scoped<{ count: number }>(
        "export.count",
        `select count(*)::int as count from rag.${table} t where ${inScope[table]}`
      ).pipe(Effect.map((rows) => rows[0]?.count ?? 0)),

    page: Effect.fnUntraced(function* (table, after, limit) {
      const exported = yield* columns(table)
      const key = keyOf(table)
      const cursor = after === null ? "" : ` and t.${key.column} > {after}::${key.type}`
      const rows = yield* scoped<{ key: string | number; row: Record<string, unknown> }>(
        "export.page",
        `select t.${key.column} as key, to_jsonb(t) as row from rag.${table} t
          where ${inScope[table]}${cursor} order by t.${key.column} limit ${limit}`,
        after === null ? null : String(after)
      )
      return {
        rows: rows.map(({ row }) =>
          Object.fromEntries(
            exported.map((column) => {
              const value = row[column.name] ?? null
              // to_jsonb renders vectors with their text form ("[0.1,0.2]").
              return [column.name, column.type === "vector" && typeof value === "string" ? JSON.parse(value) : value]
            })
          )
        ),
        next: rows.length < limit ? null : (rows.at(-1)?.key ?? null)
      }
    }),

    embeddings: scoped<{ model: string; dimensions: number; formatVersion: number; chunks: number }>(
      "export.embeddings",
      `select t.model, t.dimensions, t.format_version as "formatVersion", count(*)::int as chunks
         from rag.chunk t where ${inScope.chunk}
        group by t.model, t.dimensions, t.format_version order by t.model, t.dimensions, t.format_version`
    )
  }
  return reader
})

export const ExportRepositoryLive = Layer.effect(
  ExportRepository,
  Effect.gen(function* () {
    const { pool } = yield* Database
    return ExportRepository.of({
      open: (scope) =>
        Effect.acquireRelease(
          Effect.tryPromise({
            try: async () => {
              const client = await pool.connect()
              try {
                await client.query("begin isolation level repeatable read read only")
                // Timestamps leave to_jsonb in UTC whatever the server time zone.
                await client.query("set local time zone 'UTC'")
                return client
              } catch (error) {
                client.release(true)
                throw error
              }
            },
            catch: (cause) => new DatabaseError({ operation: "export.open", cause })
          }),
          (client) =>
            Effect.promise(() =>
              client.query("rollback").then(
                () => client.release(),
                (error: unknown) => client.release(error instanceof Error ? error : true)
              )
            )
        ).pipe(Effect.flatMap((client) => makeReader(client, scope)))
    })
  })
)
