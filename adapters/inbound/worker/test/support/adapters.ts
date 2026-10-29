/** Adapters of the integration tests: everything but the database and the models (scripted per test). */
import { CodeAnalyzerLive, FileAdaptersLive, ZipArchiveLive } from "@code-to-rag/filesystem"
import { type UploadId } from "@code-to-rag/core"
import { UploadStore } from "@code-to-rag/core/outbound"
import { SecretBoxLive } from "@code-to-rag/postgres"
import { Effect, Layer } from "effect"

export const testAdapters = Layer.mergeAll(SecretBoxLive, CodeAnalyzerLive, FileAdaptersLive, ZipArchiveLive)

/** Stores an archive as an upload, through the port the web uses. */
export const storeUpload = (uploadId: UploadId, archive: Uint8Array) =>
  UploadStore.use((uploads) =>
    uploads.receive(uploadId, new Blob([archive]).stream(), Number.MAX_SAFE_INTEGER).pipe(Effect.asVoid)
  )
