import { Effect, Schema } from "effect"
import { randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import { AppConfig } from "./config.ts"
import { UploadId } from "./domain.ts"
import { InvalidInputError } from "./errors.ts"
import { uploadPath } from "./acquisition.ts"

export class UploadError extends Schema.TaggedError<UploadError>()("UploadError", {
  reason: Schema.Literals(["too_large", "not_a_zip", "empty", "io"]),
  message: Schema.String
}) {}

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]
const EMPTY_ZIP_MAGIC = [0x50, 0x4b, 0x05, 0x06]

/**
 * Streams an uploaded archive to `DATA_DIR/uploads/<id>.zip`, enforcing the
 * size limit while reading (the declared Content-Length is not trusted). The
 * file is written under a temporary name and renamed only when complete.
 */
export const receiveUpload = Effect.fn("receiveUpload")(function* (body: ReadableStream<Uint8Array>) {
  const config = yield* AppConfig
  const id = UploadId.make(randomUUID())
  const finalPath = uploadPath(config.uploadsDir, id)
  const partialPath = `${finalPath}.part`

  const write = Effect.tryPromise({
    try: async () => {
      await fs.mkdir(config.uploadsDir, { recursive: true, mode: 0o700 })
      const handle = await fs.open(partialPath, "wx", 0o600)
      let received = 0
      let header: Array<number> = []
      try {
        const reader = body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          received += value.length
          if (received > config.limits.maxArchiveBytes) {
            await reader.cancel()
            return { _tag: "too_large" as const }
          }
          if (header.length < 4) header = [...header, ...value.subarray(0, 4 - header.length)]
          await handle.write(value)
        }
      } finally {
        await handle.close()
      }
      if (received === 0) return { _tag: "empty" as const }
      const isZip =
        ZIP_MAGIC.every((byte, i) => header[i] === byte) || EMPTY_ZIP_MAGIC.every((byte, i) => header[i] === byte)
      if (!isZip) return { _tag: "not_a_zip" as const }
      await fs.rename(partialPath, finalPath)
      return { _tag: "ok" as const, size: received }
    },
    catch: (cause) => cause
  }).pipe(
    // The cause (e.g. EACCES) stays in the server log; the user gets a generic message.
    Effect.tapError((cause) => Effect.logError("Upload could not be written", cause)),
    Effect.mapError(() => new UploadError({ reason: "io", message: "Impossibile salvare il file caricato" }))
  )

  const outcome = yield* write.pipe(Effect.onError(() => Effect.promise(() => fs.rm(partialPath, { force: true }))))
  if (outcome._tag !== "ok") {
    yield* Effect.promise(() => fs.rm(partialPath, { force: true }))
    const messages = {
      too_large: `L'archivio supera ${Math.round(config.limits.maxArchiveBytes / 1024 / 1024)} MB`,
      not_a_zip: "Il file non è un archivio zip",
      empty: "Il file è vuoto"
    } as const
    return yield* new UploadError({ reason: outcome._tag, message: messages[outcome._tag] })
  }
  return { uploadId: id, size: outcome.size }
})

export const ensureUploadExists = Effect.fn("ensureUploadExists")(function* (id: UploadId) {
  const config = yield* AppConfig
  const exists = yield* Effect.promise(() =>
    fs.access(uploadPath(config.uploadsDir, id)).then(
      () => true,
      () => false
    )
  )
  if (!exists) return yield* new InvalidInputError({ message: "Archivio caricato non trovato: caricalo di nuovo" })
})

/** Removes uploads never attached to a project (abandoned forms). */
export const removeStaleUploads = Effect.fn("removeStaleUploads")(function* (
  olderThanMs: number,
  keep: ReadonlySet<string>
) {
  const config = yield* AppConfig
  const names = yield* Effect.promise(() => fs.readdir(config.uploadsDir).catch(() => [] as Array<string>))
  let removed = 0
  for (const name of names) {
    const id = name.replace(/\.zip(\.part)?$/, "")
    if (keep.has(id)) continue
    const path = `${config.uploadsDir}/${name}`
    const stat = yield* Effect.promise(() => fs.stat(path).catch(() => undefined))
    if (stat !== undefined && Date.now() - stat.mtimeMs > olderThanMs) {
      yield* Effect.promise(() => fs.rm(path, { force: true }))
      removed++
    }
  }
  return removed
})
