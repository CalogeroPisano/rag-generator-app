import { Effect } from "effect"
import { zipSync, type Zippable } from "fflate"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as nodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { defaultLimits, type AcquisitionLimits } from "../src/limits.ts"
import type { PreparedFile } from "../src/prepare.ts"
import { scanTree } from "../src/scan.ts"
import { extractZip } from "../src/zip.ts"

const encode = (text: string) => new TextEncoder().encode(text)

let workdir: string
beforeEach(async () => {
  workdir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "code-to-rag-zip-"))
})
afterEach(async () => {
  await fs.rm(workdir, { recursive: true, force: true })
})

const writeZip = async (files: Zippable) => {
  const path = nodePath.join(workdir, "archive.zip")
  await fs.writeFile(path, zipSync(files))
  return path
}

const extract = (archive: string, limits: AcquisitionLimits = defaultLimits) => {
  const destination = nodePath.join(workdir, "out")
  return Effect.runPromise(
    Effect.promise(() => fs.mkdir(destination)).pipe(Effect.andThen(extractZip(archive, destination, limits)))
  ).then((summary) => ({ summary, destination }))
}

/** Rewrites the uncompressed size declared in the central directory, as a malicious archive would. */
const lieAboutSizes = (zip: Uint8Array, declaredSize: number) => {
  const view = Buffer.from(zip)
  for (let i = 0; i < view.length - 4; i++) {
    if (view.readUInt32LE(i) === 0x02014b50) view.writeUInt32LE(declaredSize, i + 24)
  }
  return view
}

describe("extractZip", () => {
  it("extracts regular files", async () => {
    const archive = await writeZip({ "src/main.ts": encode("export {}\n"), "README.md": encode("# hi") })
    const { summary, destination } = await extract(archive)
    expect(summary.extractedFiles).toBe(2)
    expect(await fs.readFile(nodePath.join(destination, "src/main.ts"), "utf8")).toBe("export {}\n")
  })

  it("never writes outside the destination", async () => {
    const archive = await writeZip({
      "../escape.txt": encode("x"),
      "/abs.txt": encode("x"),
      "ok/../../escape2.txt": encode("x"),
      "safe.txt": encode("x")
    })
    const { summary } = await extract(archive)
    expect(summary.rejectedUnsafePaths).toBe(3)
    expect(summary.extractedFiles).toBe(1)
    await expect(fs.access(nodePath.join(workdir, "escape.txt"))).rejects.toThrow()
    await expect(fs.access(nodePath.join(workdir, "escape2.txt"))).rejects.toThrow()
  })

  it("does not materialise symlinks", async () => {
    const archive = await writeZip({
      link: [encode("/etc/passwd"), { os: 3, attrs: (0o120777 << 16) >>> 0 }]
    })
    const { summary, destination } = await extract(archive)
    expect(summary.skipped).toEqual([{ path: "link", reason: "symlink", size: 11 }])
    await expect(fs.lstat(nodePath.join(destination, "link"))).rejects.toThrow()
  })

  it("stops inflating when the real size exceeds the limit, even if the header lies", async () => {
    const bomb = new Uint8Array(5 * 1024 * 1024)
    const zip = lieAboutSizes(zipSync({ "bomb.txt": bomb }), 10)
    const archive = nodePath.join(workdir, "bomb.zip")
    await fs.writeFile(archive, zip)
    const { summary, destination } = await extract(archive, { ...defaultLimits, maxFileBytes: 1024 })
    expect(summary.skipped[0]?.reason).toBe("too_large")
    await expect(fs.access(nodePath.join(destination, "bomb.txt"))).rejects.toThrow()
  })

  it("fails when the archive has too many entries", async () => {
    const files: Zippable = {}
    for (let i = 0; i < 20; i++) files[`f${i}.txt`] = encode("x")
    const archive = await writeZip(files)
    const result = await Effect.runPromise(
      Effect.flip(extractZip(archive, workdir, { ...defaultLimits, maxFiles: 10 }))
    )
    expect(result._tag).toBe("LimitExceededError")
  })

  it("rejects files that are not zips", async () => {
    const archive = nodePath.join(workdir, "not.zip")
    await fs.writeFile(archive, "hello")
    const result = await Effect.runPromise(Effect.flip(extractZip(archive, workdir, defaultLimits)))
    expect(result._tag).toBe("ArchiveError")
  })
})

describe("scanTree", () => {
  it("walks deterministically, skipping and reporting excluded content", async () => {
    const root = nodePath.join(workdir, "tree")
    await fs.mkdir(nodePath.join(root, "src"), { recursive: true })
    await fs.mkdir(nodePath.join(root, "node_modules/lib"), { recursive: true })
    await fs.writeFile(nodePath.join(root, "src/b.ts"), "export const b = 1\n")
    await fs.writeFile(nodePath.join(root, "src/a.ts"), `const password = "Xy7#kL9!qR2"\n`)
    await fs.writeFile(nodePath.join(root, "node_modules/lib/index.js"), "module.exports = {}")
    await fs.writeFile(nodePath.join(root, "package-lock.json"), "{}")
    await fs.symlink("/etc/passwd", nodePath.join(root, "src/link"))

    const seen: Array<PreparedFile> = []
    const summary = await Effect.runPromise(
      scanTree(root, defaultLimits, [], (file) => Effect.sync(() => void seen.push(file)))
    )

    expect(seen.map((f) => [f.path, f.excluded ?? "included"])).toEqual([
      ["node_modules", "dependency"],
      ["package-lock.json", "lockfile"],
      ["src/a.ts", "included"],
      ["src/b.ts", "included"],
      ["src/link", "symlink"]
    ])
    expect(seen[2]?.content).toBe(`const password = "[REDACTED:assigned-password]"\n`)
    expect(summary).toMatchObject({ includedFiles: 2, excludedFiles: 3, maskedSecrets: 1 })

    const again = await Effect.runPromise(scanTree(root, defaultLimits, [], () => Effect.void))
    expect(again.treeHash).toBe(summary.treeHash)
  })
})
