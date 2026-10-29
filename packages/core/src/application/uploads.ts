import { Effect, Schema } from "effect"
import { InvalidInputError } from "../domain/errors.ts"
import { UploadId } from "../domain/model.ts"
import { UploadStore } from "../ports/outbound/source.ts"
import { AppConfig } from "./config.ts"

export class UploadError extends Schema.TaggedError<UploadError>()("UploadError", {
  reason: Schema.Literals(["too_large", "not_a_zip", "empty", "io"]),
  message: Schema.String
}) {}

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]
const EMPTY_ZIP_MAGIC = [0x50, 0x4b, 0x05, 0x06]

/**
 * Receives an uploaded archive, enforcing the size limit while reading (the
 * declared Content-Length is not trusted). Anything that is not a zip is
 * removed at once.
 */
export const receiveUpload = Effect.fn("receiveUpload")(function* (body: ReadableStream<Uint8Array>) {
  const config = yield* AppConfig
  const uploads = yield* UploadStore
  const id = UploadId.make(crypto.randomUUID())
  const maxBytes = config.limits.maxArchiveBytes

  const outcome = yield* uploads.receive(id, body, maxBytes).pipe(
    // The cause (e.g. EACCES) stays in the server log; the user gets a generic message.
    Effect.tapError((error) => Effect.logError("Upload could not be written", error.cause)),
    Effect.mapError(() => new UploadError({ reason: "io", message: "Impossibile salvare il file caricato" }))
  )
  if (outcome._tag === "too_large") {
    return yield* new UploadError({
      reason: "too_large",
      message: `L'archivio supera ${Math.round(maxBytes / 1024 / 1024)} MB`
    })
  }
  const isZip = (magic: ReadonlyArray<number>) => magic.every((byte, i) => outcome.header[i] === byte)
  if (outcome.size === 0 || !(isZip(ZIP_MAGIC) || isZip(EMPTY_ZIP_MAGIC))) {
    yield* uploads.remove(id)
    return yield* outcome.size === 0
      ? new UploadError({ reason: "empty", message: "Il file è vuoto" })
      : new UploadError({ reason: "not_a_zip", message: "Il file non è un archivio zip" })
  }
  return { uploadId: id, size: outcome.size }
})

export const ensureUploadExists = Effect.fn("ensureUploadExists")(function* (id: UploadId) {
  if (!(yield* (yield* UploadStore).exists(id))) {
    return yield* new InvalidInputError({ message: "Archivio caricato non trovato: caricalo di nuovo" })
  }
})

/** Removes uploads never attached to a project (abandoned forms). */
export const removeStaleUploads = Effect.fn("removeStaleUploads")(function* (
  olderThanMs: number,
  keep: ReadonlySet<string>
) {
  return yield* (yield* UploadStore).removeStale(olderThanMs, keep)
})
