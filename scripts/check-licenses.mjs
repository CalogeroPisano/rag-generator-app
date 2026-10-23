#!/usr/bin/env node
// @ts-check
/**
 * License policy check.
 *
 * 1. Distributed code: reads the manifests written at build time by
 *    `vite-plugin-third-party.mjs` (`apps/*\/dist/third-party-licenses/*.json`),
 *    i.e. exactly the packages bundled into what we ship. Any license outside
 *    the policy fails the check, unless listed in `licenses.exceptions.json`.
 *    Apache-2.0 packages that ship a NOTICE must have it copied.
 * 2. `--all`: also reports (without failing) the licenses of every installed
 *    package, including build and development tools.
 *
 * Usage: node scripts/check-licenses.mjs [--all]   (run after `pnpm build`)
 */
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"

const root = path.resolve(import.meta.dirname, "..")

/** Licenses allowed by the commercial distribution policy. */
const ALLOWED = new Set(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "PostgreSQL"])

/** @type {Record<string, { license: string, reason: string, approvedBy: string }>} */
const exceptions = JSON.parse(fs.readFileSync(path.join(root, "licenses.exceptions.json"), "utf8")).packages

/**
 * Evaluates an SPDX expression: `A OR B` passes if either passes, `A AND B`
 * only if both pass. `WITH` exceptions are never allowed implicitly.
 * @param {string} expression
 * @returns {boolean}
 */
const isAllowed = (expression) => {
  const tokens = expression
    .replace(/[()]/g, (paren) => ` ${paren} `)
    .trim()
    .split(/\s+/)
  let position = 0
  /** @returns {boolean} */
  const parseOr = () => {
    let result = parseAnd()
    while (tokens[position] === "OR") {
      position++
      const right = parseAnd()
      result = result || right
    }
    return result
  }
  /** @returns {boolean} */
  const parseAnd = () => {
    let result = parseAtom()
    while (tokens[position] === "AND") {
      position++
      const right = parseAtom()
      result = result && right
    }
    return result
  }
  /** @returns {boolean} */
  const parseAtom = () => {
    const token = tokens[position++]
    if (token === "(") {
      const result = parseOr()
      position++ // ")"
      return result
    }
    if (tokens[position] === "WITH") {
      position += 2
      return false
    }
    return token !== undefined && ALLOWED.has(token)
  }
  return parseOr()
}

const manifests = fs
  .readdirSync(path.join(root, "apps"))
  .map((app) => path.join(root, "apps", app, "dist/third-party-licenses"))
  .filter((dir) => fs.existsSync(dir))
  .flatMap((dir) =>
    fs
      .readdirSync(dir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => ({ dir, file: path.join(dir, file) }))
  )

if (manifests.length === 0) {
  console.error("No third-party manifests found: run `pnpm build` first.")
  process.exit(1)
}

/** @type {Map<string, { name: string, version: string, license: string, files: string[], dir: string }>} */
const distributed = new Map()
for (const { dir, file } of manifests) {
  for (const entry of JSON.parse(fs.readFileSync(file, "utf8"))) {
    distributed.set(`${entry.name}@${entry.version}`, { ...entry, dir })
  }
}

const violations = []
for (const [key, entry] of distributed) {
  if (!isAllowed(entry.license)) {
    const exception = exceptions[entry.name]
    if (exception === undefined || exception.license !== entry.license) {
      violations.push(`${key}: ${entry.license}`)
    }
  }
  if (/Apache-2\.0/.test(entry.license)) {
    const copied = path.join(entry.dir, "packages", key.replace("/", "__"))
    for (const file of entry.files.filter((name) => /^notice/i.test(name))) {
      if (!fs.existsSync(path.join(copied, file))) violations.push(`${key}: NOTICE file not copied (${file})`)
    }
  }
}

console.log(`Distributed third-party packages: ${distributed.size}`)
const excepted = [...distributed.values()].filter((entry) => !isAllowed(entry.license) && exceptions[entry.name])
for (const entry of excepted) {
  console.log(`  exception: ${entry.name}@${entry.version} (${entry.license}) — ${exceptions[entry.name]?.reason}`)
}

if (process.argv.includes("--all")) {
  /** @type {Record<string, Array<{ name: string, versions: string[] }>>} */
  const all = JSON.parse(execFileSync("pnpm", ["licenses", "list", "--json"], { cwd: root, encoding: "utf8" }))
  console.log("\nInstalled packages (build and development tools included) outside the policy:")
  for (const [license, packages] of Object.entries(all)) {
    if (isAllowed(license)) continue
    for (const pkg of packages) {
      const shipped = pkg.versions.some((version) => distributed.has(`${pkg.name}@${version}`))
      console.log(`  ${pkg.name}@${pkg.versions.join(",")}: ${license}${shipped ? "" : " (not distributed)"}`)
    }
  }
}

if (violations.length > 0) {
  console.error(`\nLicense policy violations (${violations.length}):`)
  for (const violation of violations) console.error(`  ${violation}`)
  process.exit(1)
}
console.log("\nLicense check passed.")
