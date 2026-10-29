import { describe, expect, it } from "vitest"
import {
  commentText,
  exportFileName,
  type ExportManifest,
  insertStatement,
  jsonLine,
  scriptHeader,
  sqlLiteral
} from "../src/export/format.ts"

describe("sqlLiteral", () => {
  it("quotes strings for standard conforming strings", () => {
    expect(sqlLiteral("it's \\n", "text")).toBe(`'it''s \\n'`)
    expect(sqlLiteral(null, "text")).toBe("NULL")
    expect(sqlLiteral("2026-01-01T00:00:00+00:00", "timestamp with time zone")).toBe(`'2026-01-01T00:00:00+00:00'`)
  })
  it("formats numbers, booleans, JSON, arrays and vectors by column type", () => {
    expect(sqlLiteral(3, "integer")).toBe("3")
    expect(sqlLiteral(0.25, "double precision")).toBe("0.25")
    expect(sqlLiteral(true, "boolean")).toBe("TRUE")
    expect(sqlLiteral({ a: "x'y" }, "jsonb")).toBe(`'{"a":"x''y"}'::jsonb`)
    expect(sqlLiteral(["a.ts", 'b "c".ts', "d\\e"], "text[]")).toBe(`'{"a.ts","b \\"c\\".ts","d\\\\e"}'::text[]`)
    expect(sqlLiteral([], "text[]")).toBe(`'{}'::text[]`)
    expect(sqlLiteral([0.5, -1, 2e-7], "vector")).toBe(`'[0.5,-1,2e-7]'`)
  })
  it("refuses values that would not be numbers", () => {
    expect(() => sqlLiteral("1; drop table x", "integer")).toThrow()
    expect(() => sqlLiteral(["1); drop"], "vector")).toThrow()
  })
})

describe("insertStatement and jsonLine", () => {
  const columns = [
    { name: "id", type: "uuid" },
    { name: "files", type: "text[]" }
  ]
  it("writes one multi-row INSERT with quoted identifiers", () => {
    expect(
      insertStatement("feature", columns, [
        { id: "1", files: ["a"] },
        { id: "2", files: [] }
      ])
    ).toBe(`INSERT INTO "rag"."feature" ("id", "files") VALUES\n  ('1', '{"a"}'::text[]),\n  ('2', '{}'::text[]);\n`)
  })
  it("writes the columns in table order, missing ones as null", () => {
    expect(jsonLine(columns, { files: ["a"], extra: 1 })).toBe(`{"id":null,"files":["a"]}\n`)
  })
})

describe("scriptHeader", () => {
  const manifest: ExportManifest = {
    format: "code-to-rag-knowledge",
    formatVersion: 1,
    exportedAt: "2026-01-01T00:00:00.000Z",
    project: { id: "p-1", name: "Shop\r\nDROP TABLE x; --", sourceType: "zip", repositoryUrl: null },
    snapshot: { id: "s-1", revision: "abc\nDELETE", language: "en", model: "m" },
    cards: "approved-only",
    embeddings: [{ model: "bge-m3", dimensions: 1024, formatVersion: 1, chunks: 3 }],
    tables: []
  }
  it("keeps names inside comments and replaces the project's rows", () => {
    const header = scriptHeader(manifest, ['CREATE TABLE IF NOT EXISTS "rag"."snapshot" (id uuid)'])
    const lines = header.split("\n")
    // Every line before the settings is a comment.
    const settings = lines.indexOf("SET client_encoding = 'UTF8';")
    expect(lines.slice(0, settings).every((line) => line === "" || line.startsWith("--"))).toBe(true)
    expect(header).toContain("-- Project: Shop  DROP TABLE x; -- (p-1)")
    expect(header).toContain("-- Embeddings: bge-m3 (1024 dimensions)")
    expect(header).toContain(`DELETE FROM "rag"."snapshot" WHERE "project_id" = 'p-1';`)
    expect(header).toContain('CREATE TABLE IF NOT EXISTS "rag"."snapshot" (id uuid);')
  })
  it("strips control characters", () => {
    expect(commentText("a\nb\tc\u0000d")).toBe("a b c d")
  })
})

describe("exportFileName", () => {
  it("is ASCII: project, revision, scope", () => {
    expect(exportFileName("Gestione Ordini – Città", "0123456789abcdef", false)).toBe(
      "gestione-ordini-citta-0123456789-knowledge"
    )
    expect(exportFileName("日本", null, true)).toBe("project-knowledge-approved")
  })
})
