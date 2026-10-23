// @ts-check
/**
 * Copies the tree-sitter wasm files (runtime + grammars) into `dist/grammars/`
 * and records their packages in the third-party license inventory
 * (`dist/third-party-licenses/grammars.json`), since they ship as assets rather
 * than bundled JavaScript. At runtime the worker reads them from `GRAMMARS_DIR`.
 */
import * as fs from "node:fs"
import { createRequire } from "node:module"
import * as path from "node:path"

const LICENSE_FILE = /^(licen[cs]e|notice|copying|copyright)([.-].*)?$/i

/** The analysis package owns these dependencies, so resolve them from there. */
const requireFromAnalysis = createRequire(path.resolve(import.meta.dirname, "../packages/analysis/package.json"))

const WASM_FILES = [
  "web-tree-sitter/web-tree-sitter.wasm",
  "tree-sitter-typescript/tree-sitter-typescript.wasm",
  "tree-sitter-typescript/tree-sitter-tsx.wasm",
  "tree-sitter-javascript/tree-sitter-javascript.wasm",
  "tree-sitter-java/tree-sitter-java.wasm",
  "tree-sitter-c-sharp/tree-sitter-c_sharp.wasm",
  "tree-sitter-go/tree-sitter-go.wasm",
  "tree-sitter-python/tree-sitter-python.wasm"
]

/** @returns {import("vite").Plugin} */
export function treeSitterGrammars() {
  /** @type {string} */
  let distDir = ""
  return {
    name: "code-to-rag:tree-sitter-grammars",
    apply: "build",
    configResolved(config) {
      distDir = path.resolve(config.root, "dist")
    },
    writeBundle() {
      const grammarsDir = path.join(distDir, "grammars")
      const licensesDir = path.join(distDir, "third-party-licenses")
      fs.mkdirSync(grammarsDir, { recursive: true })
      /** @type {Map<string, { name: string, version: string, license: string, files: string[] }>} */
      const packages = new Map()
      for (const specifier of WASM_FILES) {
        const file = requireFromAnalysis.resolve(specifier)
        fs.copyFileSync(file, path.join(grammarsDir, path.basename(file)))
        const packageDir = path.dirname(file)
        const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"))
        if (packages.has(manifest.name)) continue
        const licenseFiles = fs.readdirSync(packageDir).filter((name) => LICENSE_FILE.test(name))
        const target = path.join(licensesDir, "packages", `${manifest.name}@${manifest.version}`.replace("/", "__"))
        fs.mkdirSync(target, { recursive: true })
        for (const name of licenseFiles) fs.copyFileSync(path.join(packageDir, name), path.join(target, name))
        packages.set(manifest.name, {
          name: manifest.name,
          version: manifest.version,
          license: typeof manifest.license === "string" ? manifest.license : "UNKNOWN",
          files: licenseFiles
        })
      }
      fs.mkdirSync(licensesDir, { recursive: true })
      const entries = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name))
      fs.writeFileSync(path.join(licensesDir, "grammars.json"), JSON.stringify(entries, null, 2) + "\n")
    }
  }
}
