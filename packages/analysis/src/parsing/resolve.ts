import { builtinModules } from "node:module"
import * as posix from "node:path/posix"
import type { GrammarId } from "./grammars.ts"
import type { RawImport } from "./model.ts"

/**
 * Where an import points to, in the granularity native to its language:
 * a file (ES modules, Python, Java classes), a directory (Go packages, Java
 * `pkg.*`), a namespace declared in the project (C#) or an external package.
 */
export type DependencyTarget =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "directory"; readonly path: string }
  | { readonly kind: "namespace"; readonly name: string }
  | { readonly kind: "external"; readonly name: string }
  | { readonly kind: "unresolved" }

export interface ResolverInput {
  /** Every file of the snapshot (included or not), with the package declared by Java/Go files. */
  readonly files: ReadonlyArray<{ readonly path: string; readonly packageName: string | null }>
  /** Contents of tsconfig*.json, jsconfig.json, package.json and go.mod files. */
  readonly configFiles: ReadonlyArray<{ readonly path: string; readonly content: string }>
  /** C# namespaces and types declared in the project (from the parse phase). */
  readonly csharpNamespaces: ReadonlyArray<string>
  readonly csharpTypes: ReadonlyArray<{ readonly qualifiedName: string; readonly path: string }>
}

export type Resolver = (fromPath: string, grammar: GrammarId, entry: RawImport) => DependencyTarget

const unresolved: DependencyTarget = { kind: "unresolved" }

// ── Shared helpers ──────────────────────────────────────────────────────────

/** Parses JSON with comments and trailing commas (tsconfig style). */
export const parseJsonc = (text: string): unknown => {
  let output = ""
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!
    const next = text[i + 1]
    if (inString) {
      output += char
      if (char === "\\") output += text[++i] ?? ""
      else if (char === '"') inString = false
    } else if (char === '"') {
      inString = true
      output += char
    } else if (char === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++
      output += "\n"
    } else if (char === "/" && next === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++
      i++
    } else {
      output += char
    }
  }
  try {
    return JSON.parse(output.replace(/,(\s*[}\]])/g, "$1"))
  } catch {
    return undefined
  }
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

const dirOf = (path: string) => {
  const dir = posix.dirname(path)
  return dir === "." ? "" : dir
}

const join = (...parts: Array<string>) => {
  const joined = posix.normalize(posix.join(...parts))
  return joined === "." ? "" : joined.replace(/^\.\//, "")
}

/** Ancestors of a directory, nearest first, ending with the root (""). */
const ancestors = (dir: string): Array<string> => {
  const result: Array<string> = []
  let current = dir
  for (;;) {
    result.push(current)
    if (current === "") return result
    current = dirOf(current)
  }
}

// ── ECMAScript ──────────────────────────────────────────────────────────────

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".d.ts", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"]
const JS_TO_TS: Readonly<Record<string, ReadonlyArray<string>>> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"]
}
const nodeBuiltins = new Set(builtinModules)

interface TsConfig {
  readonly dir: string
  readonly baseUrl: string | undefined
  readonly paths: ReadonlyArray<{ readonly pattern: string; readonly targets: ReadonlyArray<string> }>
}

const packageNameOf = (specifier: string) => {
  const parts = specifier.split("/")
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier)
}

const makeEcmascriptResolver = (input: ResolverInput, fileSet: ReadonlySet<string>) => {
  const configs = new Map(input.configFiles.map((file) => [file.path, file.content]))

  const loadTsConfig = (path: string, depth = 0): TsConfig | undefined => {
    const content = configs.get(path)
    const json = content === undefined ? undefined : record(parseJsonc(content))
    if (json === undefined || depth > 5) return undefined
    const dir = dirOf(path)
    const options = record(json["compilerOptions"])
    const parent =
      typeof json["extends"] === "string" && json["extends"].startsWith(".")
        ? loadTsConfig(
            join(dir, json["extends"].endsWith(".json") ? json["extends"] : `${json["extends"]}.json`),
            depth + 1
          )
        : undefined
    const baseUrl = typeof options?.["baseUrl"] === "string" ? join(dir, options["baseUrl"]) : parent?.baseUrl
    const pathsRecord = record(options?.["paths"])
    const paths =
      pathsRecord === undefined
        ? (parent?.paths ?? [])
        : Object.entries(pathsRecord).map(([pattern, targets]) => ({
            pattern,
            targets: (Array.isArray(targets) ? targets : [])
              .filter((target): target is string => typeof target === "string")
              .map((target) => join(baseUrl ?? dir, target))
          }))
    return { dir, baseUrl, paths }
  }

  const tsConfigs = new Map<string, TsConfig>()
  for (const path of configs.keys()) {
    const name = posix.basename(path)
    if (/^(tsconfig.*|jsconfig)\.json$/.test(name)) {
      const config = loadTsConfig(path)
      // tsconfig.json wins over tsconfig.app.json & co. in the same directory.
      if (config !== undefined && (name === "tsconfig.json" || !tsConfigs.has(config.dir)))
        tsConfigs.set(config.dir, config)
    }
  }

  const workspacePackages = new Map<string, { dir: string; entries: Array<string> }>()
  for (const [path, content] of configs) {
    if (posix.basename(path) !== "package.json") continue
    const json = record(parseJsonc(content))
    if (json === undefined || typeof json["name"] !== "string") continue
    const dir = dirOf(path)
    const entries = ["source", "module", "main", "types"]
      .map((field) => json[field])
      .filter((value): value is string => typeof value === "string")
      .map((value) => join(dir, value))
    workspacePackages.set(json["name"], { dir, entries: [...entries, join(dir, "src/index"), join(dir, "index")] })
  }

  const asFile = (base: string): string | undefined => {
    if (fileSet.has(base)) return base
    const extension = posix.extname(base)
    for (const replacement of JS_TO_TS[extension] ?? []) {
      const swapped = base.slice(0, -extension.length) + replacement
      if (fileSet.has(swapped)) return swapped
    }
    for (const candidate of SOURCE_EXTENSIONS) if (fileSet.has(base + candidate)) return base + candidate
    for (const candidate of SOURCE_EXTENSIONS) {
      const index = join(base, `index${candidate}`)
      if (fileSet.has(index)) return index
    }
    return undefined
  }

  const fromAliases = (config: TsConfig, specifier: string): string | undefined => {
    for (const { pattern, targets } of config.paths) {
      const star = pattern.indexOf("*")
      const matches =
        star < 0
          ? specifier === pattern
          : specifier.startsWith(pattern.slice(0, star)) && specifier.endsWith(pattern.slice(star + 1))
      if (!matches) continue
      const captured = star < 0 ? "" : specifier.slice(star, specifier.length - (pattern.length - star - 1))
      for (const target of targets) {
        const found = asFile(target.replace("*", captured))
        if (found !== undefined) return found
      }
    }
    return config.baseUrl === undefined ? undefined : asFile(join(config.baseUrl, specifier))
  }

  return (fromPath: string, specifier: string): DependencyTarget => {
    if (specifier.startsWith("node:") || nodeBuiltins.has(specifier)) {
      return { kind: "external", name: specifier.startsWith("node:") ? specifier : `node:${specifier}` }
    }
    if (specifier.startsWith(".") || specifier.startsWith("/")) {
      const base = specifier.startsWith("/") ? join(specifier.slice(1)) : join(dirOf(fromPath), specifier)
      const found = asFile(base)
      return found === undefined ? unresolved : { kind: "file", path: found }
    }
    for (const dir of ancestors(dirOf(fromPath))) {
      const config = tsConfigs.get(dir)
      if (config === undefined) continue
      const found = fromAliases(config, specifier)
      if (found !== undefined) return { kind: "file", path: found }
      break
    }
    const name = packageNameOf(specifier)
    const workspace = workspacePackages.get(name)
    if (workspace !== undefined) {
      const subpath = specifier.slice(name.length).replace(/^\//, "")
      const candidates =
        subpath === "" ? workspace.entries : [join(workspace.dir, subpath), join(workspace.dir, "src", subpath)]
      for (const candidate of candidates) {
        const found = asFile(candidate)
        if (found !== undefined) return { kind: "file", path: found }
      }
      return { kind: "directory", path: workspace.dir }
    }
    return { kind: "external", name }
  }
}

// ── Go ──────────────────────────────────────────────────────────────────────

const makeGoResolver = (input: ResolverInput, directoriesWithGo: ReadonlySet<string>) => {
  const modules: Array<{ path: string; dir: string }> = []
  for (const file of input.configFiles) {
    if (posix.basename(file.path) !== "go.mod") continue
    const module = /^\s*module\s+(\S+)/m.exec(file.content)?.[1]
    if (module !== undefined) modules.push({ path: module, dir: dirOf(file.path) })
  }
  modules.sort((a, b) => b.path.length - a.path.length)

  return (specifier: string): DependencyTarget => {
    for (const module of modules) {
      if (specifier !== module.path && !specifier.startsWith(`${module.path}/`)) continue
      const dir = join(module.dir, specifier.slice(module.path.length).replace(/^\//, ""))
      return directoriesWithGo.has(dir) ? { kind: "directory", path: dir } : unresolved
    }
    const segments = specifier.split("/")
    // Hosted modules (github.com/org/repo/...) are named by their first three segments.
    const name = segments[0]?.includes(".") === true ? segments.slice(0, 3).join("/") : specifier
    return { kind: "external", name }
  }
}

// ── Java ────────────────────────────────────────────────────────────────────

const makeJavaResolver = (input: ResolverInput) => {
  const classes = new Map<string, string>()
  const packageDirs = new Map<string, string>()
  for (const file of input.files) {
    if (!file.path.endsWith(".java") || file.packageName === null) continue
    classes.set(`${file.packageName}.${posix.basename(file.path, ".java")}`, file.path)
    if (!packageDirs.has(file.packageName)) packageDirs.set(file.packageName, dirOf(file.path))
  }

  const findClass = (name: string): string | undefined => {
    // Nested classes and static members: strip trailing segments until a class matches.
    let current = name
    while (current.includes(".")) {
      const found = classes.get(current)
      if (found !== undefined) return found
      current = current.slice(0, current.lastIndexOf("."))
    }
    return undefined
  }

  return (specifier: string): DependencyTarget => {
    if (specifier.endsWith(".*")) {
      const name = specifier.slice(0, -2)
      const dir = packageDirs.get(name)
      if (dir !== undefined) return { kind: "directory", path: dir }
      const owner = findClass(name)
      if (owner !== undefined) return { kind: "file", path: owner }
    } else {
      const found = findClass(specifier)
      if (found !== undefined) return { kind: "file", path: found }
    }
    return { kind: "external", name: specifier.split(".").slice(0, 2).join(".") }
  }
}

// ── C# ──────────────────────────────────────────────────────────────────────

const makeCsharpResolver = (input: ResolverInput) => {
  const namespaces = new Set(input.csharpNamespaces)
  const types = new Map(input.csharpTypes.map((type) => [type.qualifiedName, type.path]))
  return (specifier: string): DependencyTarget => {
    const type = types.get(specifier)
    if (type !== undefined) return { kind: "file", path: type }
    let current = specifier
    for (;;) {
      if (namespaces.has(current)) return { kind: "namespace", name: current }
      if (!current.includes(".")) break
      current = current.slice(0, current.lastIndexOf("."))
    }
    const segments = specifier.split(".")
    return { kind: "external", name: segments[0] === "System" ? "System" : segments.slice(0, 2).join(".") }
  }
}

// ── Python ──────────────────────────────────────────────────────────────────

const makePythonResolver = (input: ResolverInput, fileSet: ReadonlySet<string>) => {
  // Every dotted suffix of every module path, so that imports work whatever the source root is.
  const modules = new Map<string, Array<string>>()
  for (const file of input.files) {
    if (!/\.pyi?$/.test(file.path)) continue
    const withoutExtension = file.path.replace(/\.pyi?$/, "")
    const parts = withoutExtension.split("/")
    if (parts.at(-1) === "__init__") parts.pop()
    for (let start = 0; start < parts.length; start++) {
      const dotted = parts.slice(start).join(".")
      const list = modules.get(dotted) ?? []
      list.push(file.path)
      modules.set(dotted, list)
    }
  }

  const closest = (fromPath: string, candidates: ReadonlyArray<string>) =>
    [...candidates].sort((a, b) => {
      const shared = (path: string) => {
        const left = dirOf(fromPath).split("/")
        const right = dirOf(path).split("/")
        let count = 0
        while (count < left.length && left[count] === right[count]) count++
        return count
      }
      return shared(b) - shared(a) || a.length - b.length
    })[0]

  const moduleFile = (dir: string, dotted: string): string | undefined => {
    const base = join(dir, dotted.replaceAll(".", "/"))
    for (const candidate of [`${base}.py`, `${base}.pyi`, join(base, "__init__.py")]) {
      if (fileSet.has(candidate)) return candidate
    }
    return undefined
  }

  return (fromPath: string, entry: RawImport): DependencyTarget => {
    const { specifier, names } = entry
    if (specifier.startsWith(".")) {
      const dots = /^\.+/.exec(specifier)?.[0].length ?? 1
      let dir = dirOf(fromPath)
      for (let level = 1; level < dots; level++) dir = dirOf(dir)
      const rest = specifier.slice(dots)
      for (const name of names) {
        const found = moduleFile(dir, rest === "" ? name : `${rest}.${name}`)
        if (found !== undefined) return { kind: "file", path: found }
      }
      const found = rest === "" ? moduleFile(dir, "__init__") : moduleFile(dir, rest)
      return found === undefined ? unresolved : { kind: "file", path: found }
    }
    for (const dotted of [...names.filter((name) => name !== "*").map((name) => `${specifier}.${name}`), specifier]) {
      const candidates = modules.get(dotted)
      if (candidates !== undefined) return { kind: "file", path: closest(fromPath, candidates)! }
    }
    return { kind: "external", name: specifier.split(".")[0] ?? specifier }
  }
}

// ── Entry point ─────────────────────────────────────────────────────────────

/** Builds a resolver over a whole snapshot. Pure: no I/O, all inputs come from the database. */
export const makeResolver = (input: ResolverInput): Resolver => {
  const fileSet = new Set(input.files.map((file) => file.path))
  const directoriesWithGo = new Set(
    input.files.filter((file) => file.path.endsWith(".go")).map((file) => dirOf(file.path))
  )
  const ecmascript = makeEcmascriptResolver(input, fileSet)
  const go = makeGoResolver(input, directoriesWithGo)
  const java = makeJavaResolver(input)
  const csharp = makeCsharpResolver(input)
  const python = makePythonResolver(input, fileSet)

  return (fromPath, grammar, entry) => {
    switch (grammar) {
      case "typescript":
      case "tsx":
      case "javascript":
        return ecmascript(fromPath, entry.specifier)
      case "go":
        return go(entry.specifier)
      case "java":
        return java(entry.specifier)
      case "csharp":
        return csharp(entry.specifier)
      case "python":
        return python(fromPath, entry)
    }
  }
}

/** Names of the configuration files the resolver needs. */
export const isResolverConfigFile = (path: string): boolean =>
  /(^|\/)(tsconfig[^/]*\.json|jsconfig\.json|package\.json|go\.mod)$/.test(path)
