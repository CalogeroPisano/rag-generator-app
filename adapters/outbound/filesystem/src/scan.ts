import {
  type AcquisitionLimits,
  classifyDirectory,
  FsError,
  LimitExceededError,
  type SourceEntry
} from "@code-to-rag/core/outbound"
import { Effect } from "effect"
import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as nodePath from "node:path"

const fsOperation = <A>(operation: string, path: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new FsError({ operation, path, cause }) })

const excluded = (
  path: string,
  reason: (SourceEntry & { kind: "excluded" })["reason"],
  size: number,
  isDirectory = false
) => ({ kind: "excluded", path, reason, size, isDirectory }) satisfies SourceEntry

/**
 * Walks `root` in a deterministic order (names sorted), never following
 * symlinks, and hands every entry to `onEntry`: files with their original
 * bytes (classified and masked by the caller), excluded entries without
 * content. Excluded directories are reported once and not descended into.
 * `.git` is skipped silently.
 *
 * `extraExcluded` lets the caller report entries that never reached the disk
 * (e.g. symlinks or oversized entries skipped during zip extraction).
 *
 * `treeHash` is a deterministic hash of the original tree (paths and original
 * bytes), used as the snapshot identity when there is no commit. It never
 * reveals content.
 */
export const scanTree = Effect.fn("scanTree")(function* <E, R>(
  root: string,
  limits: AcquisitionLimits,
  extraExcluded: ReadonlyArray<SourceEntry>,
  onEntry: (entry: SourceEntry) => Effect.Effect<void, E, R>
) {
  const treeHash = createHash("sha256")
  let seenFiles = 0
  let totalBytes = 0

  for (const entry of extraExcluded) yield* onEntry(entry)

  const stack: Array<string> = [""]
  while (stack.length > 0) {
    const relativeDir = stack.pop()!
    const absoluteDir = nodePath.join(root, relativeDir)
    const names = (yield* fsOperation("readdir", relativeDir, () => fs.readdir(absoluteDir))).sort()
    const subdirectories: Array<string> = []

    for (const name of names) {
      const relativePath = relativeDir === "" ? name : `${relativeDir}/${name}`
      const absolutePath = nodePath.join(absoluteDir, name)
      const stat = yield* fsOperation("lstat", relativePath, () => fs.lstat(absolutePath))

      if (stat.isDirectory()) {
        if (relativeDir === "" && name === ".git") continue
        const reason = classifyDirectory(name)
        if (reason === undefined) subdirectories.push(relativePath)
        else yield* onEntry(excluded(relativePath, reason, 0, true))
        continue
      }

      seenFiles++
      if (seenFiles > limits.maxFiles) {
        return yield* new LimitExceededError({
          limit: "file_count",
          message: `Il codice sorgente contiene più di ${limits.maxFiles} file`
        })
      }
      if (stat.isSymbolicLink()) {
        yield* onEntry(excluded(relativePath, "symlink", 0))
        continue
      }
      if (!stat.isFile()) continue

      totalBytes += stat.size
      if (totalBytes > limits.maxTotalBytes) {
        return yield* new LimitExceededError({
          limit: "total_size",
          message: `Il codice sorgente supera ${limits.maxTotalBytes} byte`
        })
      }
      if (stat.size > limits.maxFileBytes) {
        treeHash.update(`${relativePath}\0size:${stat.size}\n`)
        yield* onEntry(excluded(relativePath, "too_large", stat.size))
        continue
      }

      const bytes = yield* fsOperation("read", relativePath, () => fs.readFile(absolutePath))
      treeHash.update(`${relativePath}\0${createHash("sha256").update(bytes).digest("hex")}\n`)
      yield* onEntry({ kind: "file", path: relativePath, bytes })
    }
    // Reverse so that popping keeps the sorted order.
    stack.push(...subdirectories.reverse())
  }

  return { treeHash: treeHash.digest("hex") }
})
