import { Effect } from "effect"
import { Inflate } from "fflate"
import * as fs from "node:fs/promises"
import * as nodePath from "node:path"
import {
  type AcquisitionLimits,
  ArchiveError,
  type ExclusionReason,
  FsError,
  LimitExceededError
} from "@code-to-rag/core/outbound"
import { resolveInside, sanitizeArchivePath } from "./paths.ts"

/** An entry of the central directory, the authoritative list of a zip's content. */
export interface ZipEntry {
  readonly rawName: string
  readonly isDirectory: boolean
  readonly isSymlink: boolean
  readonly isEncrypted: boolean
  readonly method: number
  readonly compressedSize: number
  readonly uncompressedSize: number
  readonly localHeaderOffset: number
}

/** An entry that was not extracted but is still recorded as an excluded file. */
export interface SkippedEntry {
  readonly path: string
  readonly reason: ExclusionReason
  readonly size: number
}

export interface ExtractionSummary {
  readonly extractedFiles: number
  readonly extractedBytes: number
  readonly skipped: ReadonlyArray<SkippedEntry>
  /** Entries whose name could escape the extraction root; never written. */
  readonly rejectedUnsafePaths: number
}

const EOCD_SIGNATURE = 0x06054b50
const EOCD64_LOCATOR_SIGNATURE = 0x07064b50
const EOCD64_SIGNATURE = 0x06064b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const MAX_U32 = 0xffffffff
const MAX_U16 = 0xffff
const S_IFMT = 0o170000
const S_IFLNK = 0o120000

const fail = (message: string) => new ArchiveError({ message })

const readAt = (handle: fs.FileHandle, position: number, length: number) =>
  Effect.tryPromise({
    try: async () => {
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, position)
      return buffer.subarray(0, bytesRead)
    },
    catch: (cause) => new FsError({ operation: "read", path: "<archive>", cause })
  })

// Values above 2^53 lose precision, but they exceed every limit anyway.
const u64 = (buffer: Buffer, offset: number): number => Number(buffer.readBigUInt64LE(offset))

const decodeName = (bytes: Buffer, utf8Flag: boolean): string => {
  if (utf8Flag) return bytes.toString("utf8")
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return bytes.toString("latin1")
  }
}

/** Reads and parses the central directory of a zip file (ZIP64 supported). */
export const readCentralDirectory = Effect.fnUntraced(function* (
  handle: fs.FileHandle,
  fileSize: number,
  limits: AcquisitionLimits
) {
  const tailLength = Math.min(fileSize, 22 + MAX_U16)
  const tail = yield* readAt(handle, fileSize - tailLength, tailLength)
  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return yield* fail("Il file non è un archivio zip valido")

  let entryCount = tail.readUInt16LE(eocd + 10)
  let directorySize = tail.readUInt32LE(eocd + 12)
  let directoryOffset = tail.readUInt32LE(eocd + 16)
  if (tail.readUInt16LE(eocd + 4) !== 0 || tail.readUInt16LE(eocd + 6) !== 0) {
    return yield* fail("Gli archivi divisi in più volumi non sono supportati")
  }

  const locatorStart = eocd - 20
  if (locatorStart >= 0 && tail.readUInt32LE(locatorStart) === EOCD64_LOCATOR_SIGNATURE) {
    const eocd64Offset = u64(tail, locatorStart + 8)
    const eocd64 = yield* readAt(handle, eocd64Offset, 56)
    if (eocd64.length < 56 || eocd64.readUInt32LE(0) !== EOCD64_SIGNATURE) {
      return yield* fail("Archivio zip danneggiato (ZIP64)")
    }
    entryCount = u64(eocd64, 32)
    directorySize = u64(eocd64, 40)
    directoryOffset = u64(eocd64, 48)
  }

  if (entryCount > limits.maxFiles) {
    return yield* new LimitExceededError({
      limit: "file_count",
      message: `L'archivio contiene ${entryCount} voci (limite ${limits.maxFiles})`
    })
  }
  if (directoryOffset + directorySize > fileSize) return yield* fail("Archivio zip danneggiato (indice centrale)")

  const directory = yield* readAt(handle, directoryOffset, directorySize)
  const entries: Array<ZipEntry> = []
  let offset = 0
  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > directory.length || directory.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      return yield* fail("Archivio zip danneggiato (voce dell'indice)")
    }
    const versionMadeBy = directory.readUInt16LE(offset + 4)
    const flags = directory.readUInt16LE(offset + 8)
    const method = directory.readUInt16LE(offset + 10)
    let compressedSize = directory.readUInt32LE(offset + 20)
    let uncompressedSize = directory.readUInt32LE(offset + 24)
    const nameLength = directory.readUInt16LE(offset + 28)
    const extraLength = directory.readUInt16LE(offset + 30)
    const commentLength = directory.readUInt16LE(offset + 32)
    const externalAttributes = directory.readUInt32LE(offset + 38)
    let localHeaderOffset = directory.readUInt32LE(offset + 42)
    const nameStart = offset + 46
    const rawName = decodeName(directory.subarray(nameStart, nameStart + nameLength), (flags & 0x0800) !== 0)

    // ZIP64 extended information: only the fields saturated in the header are present.
    let extra = nameStart + nameLength
    const extraEnd = extra + extraLength
    while (extra + 4 <= extraEnd) {
      const id = directory.readUInt16LE(extra)
      const size = directory.readUInt16LE(extra + 2)
      if (id === 0x0001) {
        let field = extra + 4
        if (uncompressedSize === MAX_U32) {
          uncompressedSize = u64(directory, field)
          field += 8
        }
        if (compressedSize === MAX_U32) {
          compressedSize = u64(directory, field)
          field += 8
        }
        if (localHeaderOffset === MAX_U32) localHeaderOffset = u64(directory, field)
      }
      extra += 4 + size
    }

    const unixMode = versionMadeBy >> 8 === 3 ? externalAttributes >>> 16 : 0
    entries.push({
      rawName,
      isDirectory: rawName.endsWith("/") || rawName.endsWith("\\"),
      isSymlink: (unixMode & S_IFMT) === S_IFLNK,
      isEncrypted: (flags & 0x0001) !== 0,
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset
    })
    offset = extraEnd + commentLength
  }
  return entries
})

type InflateOutcome =
  { readonly _tag: "ok"; readonly data: Uint8Array } | { readonly _tag: "too_large"; readonly producedBytes: number }

/**
 * Streams the compressed bytes of an entry through the decoder, aborting as
 * soon as the produced output exceeds `maxBytes`. Sizes declared in the
 * archive are never trusted.
 */
const inflateEntry = Effect.fnUntraced(function* (
  handle: fs.FileHandle,
  entry: ZipEntry,
  maxBytes: number
): Effect.fn.Return<InflateOutcome, ArchiveError | FsError> {
  const header = yield* readAt(handle, entry.localHeaderOffset, 30)
  if (header.length < 30 || header.readUInt32LE(0) !== LOCAL_SIGNATURE) {
    return yield* fail(`Archivio zip danneggiato: intestazione di ${entry.rawName}`)
  }
  let position = entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28)
  const end = position + entry.compressedSize

  // Mutated by the decoder callback.
  const output = { chunks: [] as Array<Uint8Array>, produced: 0, overflow: false }
  const collect = (data: Uint8Array) => {
    output.produced += data.length
    if (output.produced > maxBytes) output.overflow = true
    else output.chunks.push(data)
  }
  const inflater = entry.method === 8 ? new Inflate((data) => collect(data)) : undefined

  while (position < end && !output.overflow) {
    const chunk = yield* readAt(handle, position, Math.min(64 * 1024, end - position))
    if (chunk.length === 0) return yield* fail(`Archivio zip troncato: ${entry.rawName}`)
    position += chunk.length
    const final = position >= end
    if (inflater === undefined) {
      collect(new Uint8Array(chunk))
    } else {
      yield* Effect.try({
        try: () => inflater.push(new Uint8Array(chunk), final),
        catch: () => fail(`Dati compressi danneggiati: ${entry.rawName}`)
      })
    }
  }
  if (output.overflow) return { _tag: "too_large", producedBytes: output.produced }

  const data = new Uint8Array(output.produced)
  let cursor = 0
  for (const chunk of output.chunks) {
    data.set(chunk, cursor)
    cursor += chunk.length
  }
  return { _tag: "ok", data }
})

const fsOperation = <A>(operation: string, path: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new FsError({ operation, path, cause }) })

/**
 * Extracts `archivePath` into `destination`, which must be an empty directory
 * owned by the caller. Entries are validated against path traversal, symlinks
 * and encryption are never materialised, and every limit is enforced on the
 * bytes actually produced.
 */
export const extractZip = Effect.fn("extractZip")(function* (
  archivePath: string,
  destination: string,
  limits: AcquisitionLimits
) {
  const stat = yield* fsOperation("stat", archivePath, () => fs.stat(archivePath))
  if (stat.size > limits.maxArchiveBytes) {
    return yield* new LimitExceededError({
      limit: "archive_size",
      message: `L'archivio supera la dimensione massima (${limits.maxArchiveBytes} byte)`
    })
  }

  const handle = yield* Effect.acquireRelease(
    fsOperation("open", archivePath, () => fs.open(archivePath, "r")),
    (handle) => Effect.promise(() => handle.close())
  )
  const entries = yield* readCentralDirectory(handle, stat.size, limits)

  const skipped: Array<SkippedEntry> = []
  let rejectedUnsafePaths = 0
  let extractedFiles = 0
  let extractedBytes = 0

  for (const entry of entries) {
    if (entry.isDirectory) continue
    const path = sanitizeArchivePath(entry.rawName)
    if (path === undefined) {
      rejectedUnsafePaths++
      continue
    }
    const target = resolveInside(destination, path)
    if (target === undefined) {
      rejectedUnsafePaths++
      continue
    }
    if (entry.isSymlink) {
      skipped.push({ path, reason: "symlink", size: entry.uncompressedSize })
      continue
    }
    if (entry.isEncrypted || (entry.method !== 0 && entry.method !== 8)) {
      skipped.push({ path, reason: "unreadable", size: entry.uncompressedSize })
      continue
    }
    if (entry.uncompressedSize > limits.maxFileBytes) {
      skipped.push({ path, reason: "too_large", size: entry.uncompressedSize })
      continue
    }

    const outcome = yield* inflateEntry(handle, entry, limits.maxFileBytes)
    if (outcome._tag === "too_large") {
      skipped.push({ path, reason: "too_large", size: outcome.producedBytes })
      continue
    }
    extractedBytes += outcome.data.length
    if (extractedBytes > limits.maxTotalBytes) {
      return yield* new LimitExceededError({
        limit: "total_size",
        message: `Il contenuto estratto supera ${limits.maxTotalBytes} byte`
      })
    }

    const written = yield* fsOperation("write", path, async () => {
      await fs.mkdir(nodePath.dirname(target), { recursive: true, mode: 0o700 })
      await fs.writeFile(target, outcome.data, { mode: 0o600 })
    }).pipe(
      // A file and a directory with the same name (e.g. "a" and "a/b") cannot coexist.
      Effect.as(true),
      Effect.catchTag("FsError", () => Effect.succeed(false))
    )
    if (written) extractedFiles++
    else skipped.push({ path, reason: "unreadable", size: outcome.data.length })
  }

  return { extractedFiles, extractedBytes, skipped, rejectedUnsafePaths } satisfies ExtractionSummary
}, Effect.scoped)
