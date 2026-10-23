import { describe, expect, it } from "vitest"
import type { RawImport } from "../src/parsing/model.ts"
import { makeResolver, parseJsonc, type ResolverInput } from "../src/parsing/resolve.ts"

const entry = (specifier: string, names: Array<string> = [], kind: RawImport["kind"] = "import"): RawImport => ({
  specifier,
  kind,
  line: 1,
  names
})

const files = (...paths: Array<string>) => paths.map((path) => ({ path, packageName: null }))

const input = (overrides: Partial<ResolverInput>): ResolverInput => ({
  files: [],
  configFiles: [],
  csharpNamespaces: [],
  csharpTypes: [],
  ...overrides
})

describe("parseJsonc", () => {
  it("accepts comments and trailing commas", () => {
    expect(parseJsonc(`{ // c\n "a": "http://x", /* b */ "b": [1,2,], }`)).toEqual({ a: "http://x", b: [1, 2] })
  })
})

describe("ECMAScript resolution", () => {
  const resolve = makeResolver(
    input({
      files: files(
        "apps/web/src/orders/service.ts",
        "apps/web/src/orders/util.ts",
        "apps/web/src/lib/index.ts",
        "apps/web/src/components/Button.tsx",
        "packages/core/src/index.ts",
        "packages/core/src/domain.ts",
        "legacy/main.js",
        "legacy/helpers/index.js"
      ),
      configFiles: [
        {
          path: "apps/web/tsconfig.json",
          content: `{ "extends": "./tsconfig.base.json", "compilerOptions": { /* aliases */ "paths": { "@/*": ["./src/*"] } } }`
        },
        { path: "apps/web/tsconfig.base.json", content: `{ "compilerOptions": { "strict": true } }` },
        { path: "packages/core/package.json", content: `{ "name": "@acme/core", "main": "./src/index.ts" }` }
      ]
    })
  )
  const from = "apps/web/src/orders/service.ts"

  it("resolves relative paths with extensions, index files and .js → .ts", () => {
    expect(resolve(from, "typescript", entry("./util"))).toEqual({ kind: "file", path: "apps/web/src/orders/util.ts" })
    expect(resolve(from, "typescript", entry("./util.js"))).toEqual({
      kind: "file",
      path: "apps/web/src/orders/util.ts"
    })
    expect(resolve(from, "typescript", entry("../lib"))).toEqual({ kind: "file", path: "apps/web/src/lib/index.ts" })
    expect(resolve("legacy/main.js", "javascript", entry("./helpers"))).toEqual({
      kind: "file",
      path: "legacy/helpers/index.js"
    })
    expect(resolve(from, "typescript", entry("./missing"))).toEqual({ kind: "unresolved" })
  })

  it("resolves tsconfig path aliases from the nearest config", () => {
    expect(resolve(from, "typescript", entry("@/components/Button"))).toEqual({
      kind: "file",
      path: "apps/web/src/components/Button.tsx"
    })
  })

  it("resolves workspace packages and classifies externals", () => {
    expect(resolve(from, "typescript", entry("@acme/core"))).toEqual({
      kind: "file",
      path: "packages/core/src/index.ts"
    })
    expect(resolve(from, "typescript", entry("@acme/core/domain"))).toEqual({
      kind: "file",
      path: "packages/core/src/domain.ts"
    })
    expect(resolve(from, "typescript", entry("@tanstack/react-router/client"))).toEqual({
      kind: "external",
      name: "@tanstack/react-router"
    })
    expect(resolve(from, "typescript", entry("fs"))).toEqual({ kind: "external", name: "node:fs" })
    expect(resolve(from, "typescript", entry("node:path"))).toEqual({ kind: "external", name: "node:path" })
  })
})

describe("Go resolution", () => {
  const resolve = makeResolver(
    input({
      files: files("go.mod", "internal/db/db.go", "cmd/api/main.go"),
      configFiles: [{ path: "go.mod", content: "module example.com/shop\n\ngo 1.22\n" }]
    })
  )
  it("maps module paths to package directories", () => {
    expect(resolve("cmd/api/main.go", "go", entry("example.com/shop/internal/db"))).toEqual({
      kind: "directory",
      path: "internal/db"
    })
    expect(resolve("cmd/api/main.go", "go", entry("example.com/shop/internal/gone"))).toEqual({ kind: "unresolved" })
    expect(resolve("cmd/api/main.go", "go", entry("fmt"))).toEqual({ kind: "external", name: "fmt" })
    expect(resolve("cmd/api/main.go", "go", entry("github.com/jackc/pgx/v5/pgxpool"))).toEqual({
      kind: "external",
      name: "github.com/jackc/pgx"
    })
  })
})

describe("Java resolution", () => {
  const resolve = makeResolver(
    input({
      files: [
        { path: "src/main/java/com/acme/orders/OrderService.java", packageName: "com.acme.orders" },
        { path: "src/main/java/com/acme/common/Money.java", packageName: "com.acme.common" }
      ]
    })
  )
  const from = "src/main/java/com/acme/orders/OrderService.java"
  it("resolves classes, wildcards, static and nested members", () => {
    expect(resolve(from, "java", entry("com.acme.common.Money"))).toEqual({
      kind: "file",
      path: "src/main/java/com/acme/common/Money.java"
    })
    expect(resolve(from, "java", entry("com.acme.common.Money.ZERO", [], "static"))).toEqual({
      kind: "file",
      path: "src/main/java/com/acme/common/Money.java"
    })
    expect(resolve(from, "java", entry("com.acme.common.*"))).toEqual({
      kind: "directory",
      path: "src/main/java/com/acme/common"
    })
    expect(resolve(from, "java", entry("java.util.List"))).toEqual({ kind: "external", name: "java.util" })
  })
})

describe("C# resolution", () => {
  const resolve = makeResolver(
    input({
      csharpNamespaces: ["Acme.Orders", "Acme.Common"],
      csharpTypes: [{ qualifiedName: "Acme.Common.Strings", path: "Common/Strings.cs" }]
    })
  )
  it("resolves namespaces and types declared in the project", () => {
    expect(resolve("x.cs", "csharp", entry("Acme.Orders", [], "using"))).toEqual({
      kind: "namespace",
      name: "Acme.Orders"
    })
    expect(resolve("x.cs", "csharp", entry("Acme.Common.Strings", [], "static"))).toEqual({
      kind: "file",
      path: "Common/Strings.cs"
    })
    expect(resolve("x.cs", "csharp", entry("System.Collections.Generic", [], "using"))).toEqual({
      kind: "external",
      name: "System"
    })
    expect(resolve("x.cs", "csharp", entry("Microsoft.Extensions.Logging", [], "using"))).toEqual({
      kind: "external",
      name: "Microsoft.Extensions"
    })
  })
})

describe("Python resolution", () => {
  const resolve = makeResolver(
    input({
      files: files(
        "src/shop/__init__.py",
        "src/shop/orders/__init__.py",
        "src/shop/orders/service.py",
        "src/shop/orders/models.py",
        "src/shop/common/utils.py"
      )
    })
  )
  const from = "src/shop/orders/service.py"
  it("resolves absolute, relative and submodule imports", () => {
    expect(resolve(from, "python", entry("shop.common.utils", ["slugify"], "from"))).toEqual({
      kind: "file",
      path: "src/shop/common/utils.py"
    })
    expect(resolve(from, "python", entry(".", ["models"], "from"))).toEqual({
      kind: "file",
      path: "src/shop/orders/models.py"
    })
    expect(resolve(from, "python", entry("..common.utils", ["slugify"], "from"))).toEqual({
      kind: "file",
      path: "src/shop/common/utils.py"
    })
    expect(resolve(from, "python", entry("shop.orders"))).toEqual({ kind: "file", path: "src/shop/orders/__init__.py" })
    expect(resolve(from, "python", entry("requests"))).toEqual({ kind: "external", name: "requests" })
    expect(resolve(from, "python", entry("..missing", ["x"], "from"))).toEqual({ kind: "unresolved" })
  })
})
