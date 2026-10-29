/**
 * Formats of a knowledge export (phase 7): pure helpers for the JSONL archive
 * and the SQL script. Both carry the same rows, keyed by the column names of
 * the `rag` schema.
 */
import type { ExportColumn, ExportEmbedding, ExportTable } from "../ports.ts"

export type ExportFormat = "jsonl" | "sql"

/** Version of the export format (files, manifest, script layout): bump it when they change. */
export const EXPORT_FORMAT_VERSION = 1

export interface ExportTableManifest {
  /** Qualified table name, e.g. `rag.card`. */
  readonly name: string
  /** File of the archive with the rows, one JSON object per line. */
  readonly file: string
  readonly rows: number
  readonly columns: ReadonlyArray<ExportColumn>
}

export interface ExportManifest {
  readonly format: "code-to-rag-knowledge"
  readonly formatVersion: number
  readonly exportedAt: string
  readonly project: {
    readonly id: string
    readonly name: string
    readonly sourceType: string
    readonly repositoryUrl: string | null
  }
  readonly snapshot: {
    readonly id: string
    readonly revision: string
    readonly language: string
    readonly model: string
  }
  /** Cards in the export: every card except excluded ones (with their review status), or approved ones only. */
  readonly cards: "all-except-excluded" | "approved-only"
  /** Embedding models of the exported chunks: searches must embed questions with the same model. */
  readonly embeddings: ReadonlyArray<ExportEmbedding>
  readonly tables: ReadonlyArray<ExportTableManifest>
}

export const tableFile = (table: ExportTable) => `${table}.jsonl`

/** One JSONL line: the row's columns in table order. */
export const jsonLine = (columns: ReadonlyArray<ExportColumn>, row: Record<string, unknown>): string =>
  `${JSON.stringify(Object.fromEntries(columns.map((column) => [column.name, row[column.name] ?? null])))}\n`

// ── SQL ──────────────────────────────────────────────────────────────────

export const quoteIdentifier = (name: string) => `"${name.replaceAll('"', '""')}"`

/** String literal for `standard_conforming_strings = on` (set by the script): only quotes are doubled. */
export const quoteLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`

/** Text inside a `--` comment: line breaks and other control characters would end it and turn text into SQL. */
// eslint-disable-next-line no-control-regex -- control characters are exactly what must go
export const commentText = (value: string) => value.replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]/g, " ")

/** Element of a Postgres array literal (`{"a","b"}`). */
const arrayElement = (value: unknown) =>
  value === null
    ? "NULL"
    : `"${(typeof value === "string" ? value : JSON.stringify(value)).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`

const finiteNumber = (value: unknown) => {
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error("Not a finite number")
  return String(number)
}

/** SQL literal of a value read from a column of the given type. */
export const sqlLiteral = (value: unknown, type: string): string => {
  if (value === null || value === undefined) return "NULL"
  if (type === "jsonb" || type === "json") return `${quoteLiteral(JSON.stringify(value))}::${type}`
  if (type.endsWith("[]")) {
    if (!Array.isArray(value)) throw new Error("Not an array")
    return `${quoteLiteral(`{${value.map(arrayElement).join(",")}}`)}::${type}`
  }
  if (type === "vector" || type.startsWith("vector(")) {
    if (!Array.isArray(value)) throw new Error("Not a vector")
    return quoteLiteral(`[${value.map(finiteNumber).join(",")}]`)
  }
  switch (type) {
    case "boolean":
      return value === true ? "TRUE" : "FALSE"
    case "smallint":
    case "integer":
    case "bigint":
    case "real":
    case "double precision":
    case "numeric":
      return finiteNumber(value)
    default:
      return quoteLiteral(typeof value === "string" ? value : JSON.stringify(value))
  }
}

/** One multi-row INSERT. */
export const insertStatement = (
  table: ExportTable,
  columns: ReadonlyArray<ExportColumn>,
  rows: ReadonlyArray<Record<string, unknown>>
): string => {
  const names = columns.map((column) => quoteIdentifier(column.name)).join(", ")
  const values = rows
    .map((row) => `  (${columns.map((column) => sqlLiteral(row[column.name], column.type)).join(", ")})`)
    .join(",\n")
  return `INSERT INTO "rag".${quoteIdentifier(table)} (${names}) VALUES\n${values};\n`
}

/**
 * Start of the script: description (comments), session settings, transaction, schema and the deletion of what a
 * previous run of an export of the same project inserted. Everything else of the project cascades from
 * `rag.snapshot`; corrections and test questions belong to the project.
 */
export const scriptHeader = (manifest: ExportManifest, schemaStatements: ReadonlyArray<string>): string => {
  const project = quoteLiteral(manifest.project.id)
  const embeddings =
    manifest.embeddings.length === 0
      ? "none"
      : manifest.embeddings.map((embedding) => `${embedding.model} (${embedding.dimensions} dimensions)`).join(", ")
  const lines = [
    "-- Code-to-RAG knowledge export",
    `-- Project: ${commentText(manifest.project.name)} (${manifest.project.id})`,
    `-- Revision: ${commentText(manifest.snapshot.revision)}`,
    `-- Exported at: ${manifest.exportedAt}`,
    `-- Cards: ${manifest.cards}`,
    `-- Embeddings: ${commentText(embeddings)}`,
    `-- Format version: ${manifest.formatVersion}`,
    "--",
    "-- Creates the rag schema if it is missing (pgvector required) and replaces the data of this project in it,",
    "-- in one transaction: running it again gives the same result.",
    "",
    "SET client_encoding = 'UTF8';",
    "SET standard_conforming_strings = on;",
    "BEGIN;",
    "CREATE EXTENSION IF NOT EXISTS vector;",
    'CREATE SCHEMA IF NOT EXISTS "rag";',
    ...schemaStatements.map((statement) => `${statement};`),
    "",
    `DELETE FROM "rag"."correction" WHERE "project_id" = ${project};`,
    `DELETE FROM "rag"."test_question" WHERE "project_id" = ${project};`,
    `DELETE FROM "rag"."snapshot" WHERE "project_id" = ${project};`,
    ""
  ]
  return `${lines.join("\n")}\n`
}

export const scriptFooter = "COMMIT;\n"

/** File name without extension: project, revision and scope, ASCII only. */
export const exportFileName = (projectName: string, revision: string | null, approvedOnly: boolean): string => {
  const slug =
    projectName
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50)
      .replace(/-+$/, "") || "project"
  const parts = [slug, revision?.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10), "knowledge", approvedOnly ? "approved" : ""]
  return parts.filter((part) => part !== undefined && part !== "").join("-")
}
