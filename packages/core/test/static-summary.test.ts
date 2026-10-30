import { describe, expect, it } from "vitest"
import { staticSummary } from "../src/application/understanding/static-summary.ts"
import type { Declaration } from "../src/ports/outbound/repositories.ts"

const file = (path: string, language: string, content: string) => ({ path, language, contentHash: "h", content })
const declaration = (qualifiedName: string, kind: string, startLine: number, endLine: number): Declaration => ({
  path: "x",
  kind,
  qualifiedName,
  container: null,
  exported: true,
  startLine,
  endLine
})

describe("staticSummary", () => {
  it("summarizes barrels and side-effect imports without the model", () => {
    const barrel = staticSummary(
      file(
        "src/index.ts",
        "typescript",
        [
          "// Public API",
          'export * from "./orders"',
          "export { formatPrice, type Money } from './money';",
          "export {",
          "  refund,",
          '} from "./payments/refund"',
          ""
        ].join("\n")
      ),
      []
    )
    expect(barrel?.summary).toBe("Index module: re-exports ./orders, ./money, ./payments/refund. No code of its own.")
    expect(barrel).toMatchObject({ parts: 0, symbols: [] })

    expect(
      staticSummary(file("src/setupTests.js", "javascript", "import '@testing-library/jest-dom';\n"), [])?.summary
    ).toBe("Imports @testing-library/jest-dom for their side effects only. No code of its own.")
    expect(
      staticSummary(
        file("pkg/__init__.py", "python", '"""Package."""\nfrom .orders import (\n  Order,\n)\n__all__ = ["Order"]\n'),
        []
      )?.summary
    ).toBe("Package index: exposes .orders. No code of its own.")
    expect(staticSummary(file("src/empty.ts", "typescript", "/* nothing here */\n"), [])?.summary).toBe(
      "Empty file: no code, at most comments."
    )
  })

  it("summarizes TypeScript files of type definitions only", () => {
    const content = [
      'import type { Money } from "./money"',
      "",
      "/** An order. */",
      "export interface Order {",
      "  qty: number",
      "  price: Money",
      "}",
      'export type Status = "open" | "closed"',
      ""
    ].join("\n")
    const result = staticSummary(file("src/types.ts", "typescript", content), [
      declaration("Order", "interface", 4, 7),
      { ...declaration("Order.qty", "property", 5, 5), container: "Order" },
      declaration("Status", "type", 8, 8)
    ])
    expect(result?.summary).toBe("Type definitions only (no runtime code): Order, Status.")
    expect(result?.symbols.map((s) => [s.qualifiedName, s.kind])).toEqual([
      ["Order", "interface"],
      ["Status", "type"]
    ])
  })

  it("leaves files with behaviour to the language model", () => {
    // Code next to the imports.
    expect(
      staticSummary(file("src/index.js", "javascript", 'import App from "./App"\nReactDOM.render(<App />, root)\n'), [])
    ).toBeUndefined()
    // A function next to the types.
    expect(
      staticSummary(file("src/types.ts", "typescript", "export type A = string\nexport function f() { return 1 }\n"), [
        declaration("A", "type", 1, 1),
        declaration("f", "function", 2, 2)
      ])
    ).toBeUndefined()
    // Runtime code outside the type declarations.
    expect(
      staticSummary(file("src/types.ts", "typescript", "export type A = string\nconsole.log(1)\n"), [
        declaration("A", "type", 1, 1)
      ])
    ).toBeUndefined()
    // Constants may hold product rules (limits, defaults): the model reads them.
    expect(
      staticSummary(file("src/limits.ts", "typescript", "export const MAX = 100\n"), [
        declaration("MAX", "constant", 1, 1)
      ])
    ).toBeUndefined()
    // Configuration files and other languages are never summarized by rules.
    expect(staticSummary(file("config/app.json", "json", "{}\n"), [])).toBeUndefined()
    expect(staticSummary(file("src/Main.java", "java", "package a;\nimport b.C;\n"), [])).toBeUndefined()
  })
})
