import type { CardContent } from "../src/domain/card.ts"
import { describe, expect, it } from "vitest"
import { SourceFileEntry } from "../src/domain/model.ts"
import type { Declaration } from "../src/ports/outbound/repositories.ts"
import { buildCardExcerpts, citedExcerpts } from "../src/application/understanding/excerpts.ts"
import { dedupeFeatures, mergeFeatures, normalizeFeatures } from "../src/application/understanding/features.ts"
import { planModules } from "../src/application/understanding/modules.ts"
import { splitIntoParts } from "../src/application/understanding/parts.ts"
import { checkReferences } from "../src/application/understanding/references.ts"
import { selectFiles } from "../src/application/understanding/select.ts"

const entry = (path: string, language: string, extra: Partial<SourceFileEntry> = {}) =>
  new SourceFileEntry({
    path,
    language,
    size: 100,
    isDirectory: false,
    excludedReason: null,
    lineCount: 10,
    secretCount: 0,
    parseErrors: null,
    ...extra
  })

const declaration = (path: string, qualifiedName: string, startLine: number, endLine: number): Declaration => ({
  path,
  kind: "function",
  qualifiedName,
  container: qualifiedName.includes(".") ? qualifiedName.slice(0, qualifiedName.lastIndexOf(".")) : null,
  exported: true,
  startLine,
  endLine
})

describe("selectFiles", () => {
  it("keeps application code and configuration, skips tests, docs and excluded files", () => {
    const selected = selectFiles([
      entry("src/orders/service.ts", "typescript"),
      entry("src/orders/service.test.ts", "typescript"),
      entry("src/__tests__/helpers.ts", "typescript"),
      entry("internal/db/db_test.go", "go"),
      entry("tests/test_orders.py", "python"),
      entry("src/test/java/OrdersTest.java", "java"),
      entry("src/main/resources/application.properties", "ini"),
      entry("appsettings.Development.json", "json"),
      entry("package.json", "json"),
      entry("README.md", "markdown"),
      entry("dist", "plaintext", { isDirectory: true }),
      entry("vendor/lib.js", "javascript", { excludedReason: "dependency" }),
      entry("src/empty.ts", "typescript", { lineCount: 0 })
    ]).map((file) => file.path)
    expect(selected).toEqual([
      "src/orders/service.ts",
      "src/main/resources/application.properties",
      "appsettings.Development.json"
    ])
  })
})

describe("splitIntoParts", () => {
  it("keeps a small file whole", () => {
    const lines = ["a", "b", "c"]
    expect(splitIntoParts(lines, [], 1000)).toEqual([{ firstLine: 1, lines }])
  })

  it("cuts large files at declaration boundaries and covers every line once", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1} ${"x".repeat(20)}`)
    const boundaries = [1, 11, 21, 31, 41, 51, 61, 71, 81, 91]
    const parts = splitIntoParts(lines, boundaries, 300)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.flatMap((part) => part.lines)).toEqual(lines)
    // Every part except the first starts where a declaration starts.
    expect(parts.slice(1).every((part) => boundaries.includes(part.firstLine))).toBe(true)
  })

  it("never loops on a single line larger than the budget", () => {
    const parts = splitIntoParts(["y".repeat(10_000), "z"], [], 10)
    expect(parts.map((part) => part.firstLine)).toEqual([1, 2])
  })
})

describe("planModules", () => {
  it("skips pass-through directories and orders modules bottom-up", () => {
    const plan = planModules([
      "README.ts",
      "src/main/java/com/acme/orders/Orders.java",
      "src/main/java/com/acme/orders/OrderLine.java",
      "src/main/java/com/acme/billing/Invoice.java",
      "web/app.ts"
    ])
    expect(plan.map((module) => [module.path, module.files.length, module.modules, module.fileCount])).toEqual([
      ["src/main/java/com/acme/billing", 1, [], 1],
      ["src/main/java/com/acme/orders", 2, [], 2],
      ["src/main/java/com/acme", 0, ["src/main/java/com/acme/billing", "src/main/java/com/acme/orders"], 3],
      ["web", 1, [], 1],
      // "src", "src/main"… have a single child and no files: the root sees "src/main/java/com/acme" directly.
      ["", 1, ["src/main/java/com/acme", "web"], 5]
    ])
  })
})

describe("feature normalization", () => {
  const known = {
    files: new Set(["src/orders.ts", "src/billing.ts"]),
    declarations: [
      declaration("src/orders.ts", "OrderService", 1, 20),
      declaration("src/orders.ts", "OrderService.create", 3, 10)
    ]
  }

  it("keeps only existing files and declarations", () => {
    const features = normalizeFeatures(
      [
        {
          name: " Orders ",
          description: "Create orders.",
          files: ["./src/orders.ts", "src/invented.ts", "src/orders.ts"],
          symbols: ["create", "Unknown"]
        },
        { name: "Ghost", description: "Nothing real.", files: ["nope.ts"], symbols: [] }
      ],
      known
    )
    expect(features).toEqual([
      {
        name: "Orders",
        description: "Create orders.",
        files: ["src/orders.ts"],
        symbols: [{ path: "src/orders.ts", qualifiedName: "OrderService.create" }]
      }
    ])
  })

  it("merges candidates and keeps the ones the merge forgot", () => {
    const candidates = [
      { name: "Orders", description: "a", files: ["src/orders.ts"], symbols: [] },
      { name: "Order creation", description: "b", files: ["src/orders.ts"], symbols: [] },
      { name: "Billing", description: "c", files: ["src/billing.ts"], symbols: [] }
    ]
    const merged = mergeFeatures(candidates, {
      features: [{ name: "Orders", description: "Orders.", candidates: [1, 2, 2, 99] }]
    })
    expect(merged.map((f) => [f.name, f.files])).toEqual([
      ["Orders", ["src/orders.ts"]],
      ["Billing", ["src/billing.ts"]]
    ])
    expect(dedupeFeatures([...merged, { ...candidates[2]!, name: "billing", files: ["src/orders.ts"] }])).toHaveLength(
      2
    )
  })
})

describe("card excerpts and references", () => {
  const file = (path: string, lines: number) => ({
    path,
    language: "typescript",
    contentHash: "h",
    content: Array.from({ length: lines }, (_, i) => `const line${i + 1} = ${i + 1}`).join("\n")
  })

  it("shows whole files when they fit", () => {
    const { excerpts, omitted, shown } = buildCardExcerpts({
      files: [file("a.ts", 10), file("b.ts", 5)],
      summaries: new Map([["a.ts", "File A."]]),
      featureSymbols: [],
      declarations: [],
      maxTokens: 10_000
    })
    expect(excerpts.map((e) => [e.path, e.ranges.length, e.ranges[0]?.lines.length])).toEqual([
      ["b.ts", 1, 5],
      ["a.ts", 1, 10]
    ])
    expect(omitted).toEqual([])
    expect(shown.get("a.ts")).toEqual({ totalLines: 10, ranges: [[1, 10]] })
  })

  it("falls back to the feature declarations and the head of other files, then to summaries only", () => {
    const input = {
      files: [file("big.ts", 2000), file("other.ts", 2000)],
      summaries: new Map([["other.ts", "Other."]]),
      featureSymbols: [{ path: "big.ts", qualifiedName: "create" }],
      declarations: [declaration("big.ts", "create", 100, 120)]
    }
    const roomy = buildCardExcerpts({ ...input, maxTokens: 1500 })
    expect(roomy.shown.get("big.ts")?.ranges).toEqual([[97, 123]])
    expect(roomy.shown.get("other.ts")?.ranges).toEqual([[1, 60]])
    expect(roomy.omitted).toEqual([])

    const tight = buildCardExcerpts({ ...input, maxTokens: 400 })
    expect(tight.excerpts.map((e) => e.path)).toEqual(["big.ts"])
    expect(tight.omitted).toEqual([{ path: "other.ts", summary: "Other." }])
  })

  it("drops references outside what the model was shown and counts unsupported statements", () => {
    const content: CardContent = {
      title: "Orders",
      summary: "Create orders.",
      behavior: [
        { text: "Creates an order.", references: [{ path: "./big.ts", startLine: 110.2, endLine: 105 }] },
        { text: "Invented.", references: [{ path: "big.ts", startLine: 1, endLine: 5 }] }
      ],
      configuration: [],
      parameters: [
        {
          name: "qty",
          description: "Quantity",
          type: "number",
          required: true,
          defaultValue: null,
          references: [{ path: "elsewhere.ts", startLine: 1, endLine: 2 }]
        }
      ],
      limits: [],
      validationRules: [{ text: "At most 100.", references: [{ path: "big.ts", startLine: 120, endLine: 9999 }] }],
      errors: []
    }
    const checked = checkReferences(content, new Map([["big.ts", { totalLines: 2000, ranges: [[97, 123] as const] }]]))
    expect(checked.references.map((r) => [r.section, r.itemIndex, r.path, r.startLine, r.endLine])).toEqual([
      ["behavior", 0, "big.ts", 105, 110],
      ["validationRules", 0, "big.ts", 120, 2000]
    ])
    expect(checked.unreferencedStatements).toBe(2)
    expect(checked.content.behavior[1]?.references).toEqual([])
  })

  it("shows only the cited lines of a statement, with context, within the budget", () => {
    const files = [file("a.ts", 100), file("b.ts", 100)]
    const excerpts = citedExcerpts({
      files,
      references: [
        { path: "a.ts", startLine: 50, endLine: 52 },
        { path: "a.ts", startLine: 58, endLine: 60 },
        { path: "missing.ts", startLine: 1, endLine: 2 },
        { path: "b.ts", startLine: 1, endLine: 1 }
      ],
      maxTokens: 10_000
    })
    // Overlapping contexts merge; ranges are clamped to the file.
    expect(excerpts.map((e) => [e.path, e.summary, e.ranges.map((r) => [r.firstLine, r.lines.length])])).toEqual([
      ["a.ts", null, [[40, 31]]],
      ["b.ts", null, [[1, 11]]]
    ])
    expect(citedExcerpts({ files, references: [{ path: "a.ts", startLine: 1, endLine: 100 }], maxTokens: 50 })).toEqual(
      []
    )
  })
})
