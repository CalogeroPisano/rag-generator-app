import { Effect } from "effect"
import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as nodePath from "node:path"
import { FsError, LimitExceededError } from "./errors.ts"
import { classifyDirectory } from "./filters.ts"
import type { AcquisitionLimits } from "./limits.ts"
import { excludedFile, prepareFile, type PreparedFile } from "./prepare.ts"

export interface ScanSummary {
  readonly includedFiles: number
  readonly excludedFiles: number
  readonly maskedSecrets: number
  /**
   * Deterministic hash of the original tree (paths and original bytes), used
   * as the snapshot identity when there is no commit. It never reveals content.
   */
  readonly treeHash: string
}

const fsOperation = <A>(operation: string, path: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new FsError({ operation, path, cause }) })

/**
 * Walks `root` in a deterministic order (names sorted), never following
 * symlinks, and hands every file to `onFile` already classified and masked.
 * Excluded directories are reported once and not descended into. `.git` is
 * skipped silently.
 *
 * `extraExcluded` lets the caller report entries that never reached the disk
 * (e.g. symlinks or oversized entries skipped during zip extraction).
 */
export const scanTree = Effect.fn("scanTree")(function* <E, R>(
  root: string,
  limits: AcquisitionLimits,
  extraExcluded: ReadonlyArray<PreparedFile>,
  onFile: (file: PreparedFile) => Effect.Effect<void, E, R>
) {
  const treeHash = createHash("sha256")
  let includedFiles = 0
  let excludedFiles = 0
  let maskedSecrets = 0
  let seenFiles = 0
  let totalBytes = 0

  const emit = Effect.fnUntraced(function* (file: PreparedFile) {
    if (file.excluded === undefined) includedFiles++
    else excludedFiles++
    maskedSecrets += file.secrets.length
    yield* onFile(file)
  })

  for (const file of extraExcluded) yield* emit(file)

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
        else yield* emit(excludedFile(relativePath, reason, 0, true))
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
        yield* emit(excludedFile(relativePath, "symlink", 0))
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
        yield* emit(excludedFile(relativePath, "too_large", stat.size))
        continue
      }

      const bytes = yield* fsOperation("read", relativePath, () => fs.readFile(absolutePath))
      treeHash.update(`${relativePath}\0${createHash("sha256").update(bytes).digest("hex")}\n`)
      yield* emit(prepareFile(relativePath, bytes, limits))
    }
    // Reverse so that popping keeps the sorted order.
    stack.push(...subdirectories.reverse())
  }

  return {
    includedFiles,
    excludedFiles,
    maskedSecrets,
    treeHash: treeHash.digest("hex")
  } satisfies ScanSummary
})
