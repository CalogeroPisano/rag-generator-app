import { Effect, Exit, Scope } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { makeCodeAnalyzer } from "../src/parsing/analyzer.ts"
import { grammarForPath } from "../src/parsing/grammars.ts"
import type { CodeAnalyzer, FileAnalysis } from "@code-to-rag/core/outbound"

let scope: Scope.Closeable
let analyzer: CodeAnalyzer["Service"]

beforeAll(async () => {
  scope = await Effect.runPromise(Scope.make())
  analyzer = await Effect.runPromise(Scope.provide(scope)(makeCodeAnalyzer(undefined)))
})
afterAll(() => Effect.runPromise(Scope.close(scope, Exit.void)))

const analyze = (path: string, content: string): FileAnalysis => {
  const result = analyzer.analyze(path, content)
  if (result === undefined) throw new Error(`no grammar for ${path}`)
  return result
}

/** `kind qualifiedName` of every symbol, plus `+` when exported. */
const outline = (result: FileAnalysis) =>
  result.symbols.map((symbol) => `${symbol.kind} ${symbol.qualifiedName}${symbol.exported ? " +" : ""}`)

describe("grammarForPath", () => {
  it("maps extensions to grammars", () => {
    expect(grammarForPath("a/b.ts")).toBe("typescript")
    expect(grammarForPath("types.d.ts")).toBe("typescript")
    expect(grammarForPath("App.tsx")).toBe("tsx")
    expect(grammarForPath("x.mjs")).toBe("javascript")
    expect(grammarForPath("Foo.cs")).toBe("csharp")
    expect(grammarForPath("README.md")).toBeUndefined()
  })
})

describe("TypeScript", () => {
  const source = `import { a, b as c } from "./util"
import * as ns from "../lib/index.js"
export { x } from "./re"
const lazy = await import("./dyn")
/** Order aggregate. */
export interface Order { id: string }
export type Id = string
export abstract class Service {
  private secret = 1
  static readonly LIMIT = 100
  constructor(x: number) {}
  async create(qty: number): Promise<void> {
    const inner = () => 1
  }
}
export const handler = async (req: Request) => {}
const local = 5
function helper() { return { method() {} } }
`
  const result = () => analyze("src/orders/service.ts", source)

  it("extracts top-level and class symbols only", () => {
    expect(outline(result())).toEqual([
      "variable lazy",
      "interface Order +",
      "type Id +",
      "class Service +",
      "field Service.secret",
      "constant Service.LIMIT +",
      "constructor Service.constructor +",
      "method Service.create +",
      "function handler +",
      "variable local",
      "function helper"
    ])
  })

  it("records lines, signature and doc comments", () => {
    const create = result().symbols.find((symbol) => symbol.qualifiedName === "Service.create")!
    expect([create.startLine, create.endLine]).toEqual([12, 14])
    expect(create.signature).toBe("async create(qty: number): Promise<void>")
    expect(result().symbols.find((symbol) => symbol.name === "Order")?.doc).toBe("/** Order aggregate. */")
  })

  it("extracts imports, re-exports and dynamic imports", () => {
    expect(result().imports.map((entry) => [entry.kind, entry.specifier, entry.names.join(",")])).toEqual([
      ["import", "./util", "a,b"],
      ["import", "../lib/index.js", "*"],
      ["reexport", "./re", "x"],
      ["dynamic", "./dyn", ""]
    ])
  })

  it("handles TSX and CommonJS", () => {
    const tsx = analyze("App.tsx", `import React from "react"\nexport function App() { return <div /> }\n`)
    expect(outline(tsx)).toEqual(["function App +"])
    const cjs = analyze(
      "legacy.js",
      `const fs = require("fs")\nclass Widget { render() {} }\nmodule.exports = Widget\n`
    )
    expect(cjs.imports.map((entry) => [entry.kind, entry.specifier])).toEqual([["require", "fs"]])
    expect(outline(cjs)).toEqual(["variable fs", "class Widget", "method Widget.render +"])
  })
})

describe("Java", () => {
  const result = () =>
    analyze(
      "src/main/java/com/acme/orders/OrderService.java",
      `package com.acme.orders;
import java.util.List;
import com.acme.common.*;
import static com.acme.util.Strings.trim;

/** Creates orders. */
public class OrderService {
  private static final int maxItems = 100;
  public OrderService(Repo repo) {}
  public Order create(int qty) { return null; }
  enum Kind { A }
}
interface Api { void create(); }
`
    )

  it("extracts package, symbols and imports", () => {
    expect(result().packageName).toBe("com.acme.orders")
    expect(outline(result())).toEqual([
      "class OrderService +",
      "constant OrderService.maxItems",
      "constructor OrderService.OrderService +",
      "method OrderService.create +",
      "enum OrderService.Kind",
      "interface Api",
      "method Api.create +"
    ])
    expect(result().symbols[0]?.doc).toBe("/** Creates orders. */")
    expect(result().imports.map((entry) => [entry.kind, entry.specifier])).toEqual([
      ["import", "java.util.List"],
      ["import", "com.acme.common.*"],
      ["static", "com.acme.util.Strings.trim"]
    ])
  })
})

describe("C#", () => {
  it("qualifies names with block and file-scoped namespaces", () => {
    const block = analyze(
      "Orders/OrderService.cs",
      `using System;
using Acme.Common;
using Alias = Acme.Other.Thing;
namespace Acme.Orders
{
  /// <summary>Creates orders.</summary>
  public class OrderService
  {
    private const int Max = 100;
    public int Count { get; set; }
    public Order Create(int qty) { return null; }
  }
}
`
    )
    expect(outline(block)).toEqual([
      "namespace Acme.Orders +",
      "class Acme.Orders.OrderService +",
      "constant Acme.Orders.OrderService.Max",
      "property Acme.Orders.OrderService.Count +",
      "method Acme.Orders.OrderService.Create +"
    ])
    expect(block.symbols[1]?.doc).toBe("/// <summary>Creates orders.</summary>")
    expect(block.imports.map((entry) => entry.specifier)).toEqual(["System", "Acme.Common", "Acme.Other.Thing"])

    const scoped = analyze("Api.cs", `namespace Acme.Api;\npublic interface IApi { void Run(); }\n`)
    expect(outline(scoped)).toEqual(["namespace Acme.Api +", "interface Acme.Api.IApi +", "method Acme.Api.IApi.Run +"])
  })
})

describe("Go", () => {
  it("attaches methods to their receiver and applies capitalisation rules", () => {
    const result = analyze(
      "internal/orders/order.go",
      `package orders
import (
  "fmt"
  db "example.com/shop/internal/db"
)
const MaxItems = 100
var cache = map[string]int{}
type Order struct { ID string }
type repo interface { Find() }
func New() *Order { x := 1; _ = x; return nil }
func (o *Order) Total() int { return 0 }
`
    )
    expect(result.packageName).toBe("orders")
    expect(outline(result)).toEqual([
      "constant MaxItems +",
      "variable cache",
      "struct Order +",
      "interface repo",
      "function New +",
      "method Order.Total +"
    ])
    expect(result.imports.map((entry) => entry.specifier)).toEqual(["fmt", "example.com/shop/internal/db"])
  })
})

describe("Python", () => {
  it("distinguishes methods, constructors, nested functions and docstrings", () => {
    const result = analyze(
      "shop/orders/service.py",
      `import os
from . import models
from ..common.utils import slugify, Money
MAX_ITEMS = 100
class OrderService(Base):
    """Creates orders."""
    def __init__(self): pass
    def create(self, qty):
        def validate(): pass
    def _internal(self): pass
def make(): pass
`
    )
    expect(outline(result)).toEqual([
      "constant MAX_ITEMS +",
      "class OrderService +",
      "constructor OrderService.__init__ +",
      "method OrderService.create +",
      "method OrderService._internal",
      "function make +"
    ])
    expect(result.symbols[1]?.doc).toBe('"""Creates orders."""')
    expect(result.imports.map((entry) => [entry.kind, entry.specifier, entry.names.join(",")])).toEqual([
      ["import", "os", ""],
      ["from", ".", "models"],
      ["from", "..common.utils", "slugify,Money"]
    ])
  })
})

describe("robustness", () => {
  it("reports syntax errors but keeps what it can", () => {
    const result = analyze("broken.ts", "export function ok() {}\nexport class {{{\n")
    expect(result.parseErrors).toBeGreaterThan(0)
    expect(result.symbols.some((symbol) => symbol.name === "ok")).toBe(true)
  })

  it("ignores languages without a grammar", () => {
    expect(analyzer.analyze("README.md", "# hi")).toBeUndefined()
  })
})
