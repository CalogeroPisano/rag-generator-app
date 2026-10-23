// @ts-check
/**
 * Records every third-party package whose code ends up in the bundles and
 * copies its LICENSE / NOTICE / COPYING files next to the build output
 * (`dist/third-party-licenses/`), so they ship with the distribution.
 * `scripts/check-licenses.mjs` reads the manifests to enforce the policy.
 */
import * as fs from "node:fs"
import * as path from "node:path"

const NODE_MODULES = "/node_modules/"
const LICENSE_FILE = /^(licen[cs]e|notice|copying|copyright)([.-].*)?$/i

/** @param {string} id */
const packageDirOf = (id) => {
  const file = id.replace(/^\0/, "").split("?")[0] ?? ""
  const index = file.lastIndexOf(NODE_MODULES)
  if (index < 0) return undefined
  const rest = file.slice(index + NODE_MODULES.length).split("/")
  const nameParts = rest[0]?.startsWith("@") ? rest.slice(0, 2) : rest.slice(0, 1)
  return file.slice(0, index + NODE_MODULES.length) + nameParts.join("/")
}

/** @param {unknown} license */
const normaliseLicense = (license) => {
  if (typeof license === "string") return license
  if (Array.isArray(license)) return license.map((entry) => normaliseLicense(entry)).join(" OR ")
  if (license !== null && typeof license === "object" && "type" in license) return String(license.type)
  return "UNKNOWN"
}

/**
 * @param {{ manifestName?: string }} [options] `manifestName` distinguishes
 *   several builds of the same app writing to the same `dist/`.
 * @returns {import("vite").Plugin}
 */
export function thirdPartyLicenses(options = {}) {
  /** @type {string} */
  let outDir = ""
  return {
    name: "code-to-rag:third-party-licenses",
    apply: "build",
    configResolved(config) {
      outDir = path.resolve(config.root, "dist/third-party-licenses")
    },
    generateBundle(_options, bundle) {
      /** @type {Map<string, { name: string, version: string, license: string, files: string[] }>} */
      const packages = new Map()
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue
        for (const id of output.moduleIds) {
          const dir = packageDirOf(id)
          if (dir === undefined || packages.has(dir)) continue
          const manifestPath = path.join(dir, "package.json")
          if (!fs.existsSync(manifestPath)) continue
          const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
          const license = normaliseLicense(manifest.license ?? manifest.licenses)
          const target = path.join(outDir, "packages", `${manifest.name}@${manifest.version}`.replace("/", "__"))
          const files = fs.readdirSync(dir).filter((file) => LICENSE_FILE.test(file))
          fs.mkdirSync(target, { recursive: true })
          for (const file of files) fs.copyFileSync(path.join(dir, file), path.join(target, file))
          packages.set(dir, { name: manifest.name, version: manifest.version, license, files })
        }
      }
      // One manifest per build environment (client, ssr, ...).
      const environment = options.manifestName ?? this.environment.name
      fs.mkdirSync(outDir, { recursive: true })
      const entries = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name))
      fs.writeFileSync(path.join(outDir, `${environment}.json`), JSON.stringify(entries, null, 2) + "\n")
    }
  }
}
