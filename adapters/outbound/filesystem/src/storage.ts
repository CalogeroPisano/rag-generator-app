/**
 * Adapters of the source ports on the local file system, under `DATA_DIR`
 * (shared by web and worker): uploads in `uploads/<id>.zip`, the per-job work
 * areas in `work/<jobId>` (only the worker writes there; deleted at the end).
 */
import {
  ExclusionReason,
  FsError,
  type JobId,
  type SourceEntry,
  SourceWorkspace,
  type UploadId,
  UploadStore
} from "@code-to-rag/core/outbound"
import { Config, Context, Effect, Layer, Schema } from "effect"
import * as fs from "node:fs/promises"
import * as nodePath from "node:path"
import { cloneRepository } from "./git.ts"
import { scanTree } from "./scan.ts"
import { extractZip } from "./zip.ts"

export interface StorageConfigShape {
  /** Root of the data shared by web and worker. */
  readonly dataDir: string
  readonly uploadsDir: string
  readonly workDir: string
}

export class StorageConfig extends Context.Service<StorageConfig, StorageConfigShape>()(
  "code-to-rag/analysis/StorageConfig"
) {
  static readonly layer = Layer.effect(
    StorageConfig,
    Effect.gen(function* () {
      const dataDir = nodePath.resolve(yield* Config.String("DATA_DIR").pipe(Config.withDefault("./.data")))
      return { dataDir, uploadsDir: nodePath.join(dataDir, "uploads"), workDir: nodePath.join(dataDir, "work") }
    })
  )
}

export const uploadPath = (uploadsDir: string, uploadId: UploadId) => nodePath.join(uploadsDir, `${uploadId}.zip`)

const exists = (path: string) =>
  Effect.promise(() =>
    fs.access(path).then(
      () => true,
      () => false
    )
  )

export const UploadStoreLive = Layer.effect(
  UploadStore,
  Effect.gen(function* () {
    const { uploadsDir } = yield* StorageConfig
    return UploadStore.of({
      receive: (id, body, maxBytes) => {
        const finalPath = uploadPath(uploadsDir, id)
        const partialPath = `${finalPath}.part`
        const removePartial = Effect.promise(() => fs.rm(partialPath, { force: true }))
        return Effect.tryPromise({
          try: async () => {
            await fs.mkdir(uploadsDir, { recursive: true, mode: 0o700 })
            const handle = await fs.open(partialPath, "wx", 0o600)
            let received = 0
            let header: Array<number> = []
            try {
              const reader = body.getReader()
              for (;;) {
                const { done, value } = await reader.read()
                if (done) break
                received += value.length
                if (received > maxBytes) {
                  await reader.cancel()
                  return { _tag: "too_large" as const }
                }
                if (header.length < 4) header = [...header, ...value.subarray(0, 4 - header.length)]
                await handle.write(value)
              }
            } finally {
              await handle.close()
            }
            await fs.rename(partialPath, finalPath)
            return { _tag: "stored" as const, size: received, header: Uint8Array.from(header) }
          },
          catch: (cause) => new FsError({ operation: "write", path: "<upload>", cause })
        }).pipe(
          Effect.tap((outcome) => (outcome._tag === "stored" ? Effect.void : removePartial)),
          Effect.onError(() => removePartial)
        )
      },
      exists: (id) => exists(uploadPath(uploadsDir, id)),
      remove: (id) => Effect.promise(() => fs.rm(uploadPath(uploadsDir, id), { force: true })),
      removeStale: Effect.fnUntraced(function* (olderThanMs, keep) {
        const names = yield* Effect.promise(() => fs.readdir(uploadsDir).catch(() => [] as Array<string>))
        let removed = 0
        for (const name of names) {
          const id = name.replace(/\.zip(\.part)?$/, "")
          if (keep.has(id)) continue
          const path = nodePath.join(uploadsDir, name)
          const stat = yield* Effect.promise(() => fs.stat(path).catch(() => undefined))
          if (stat !== undefined && Date.now() - stat.mtimeMs > olderThanMs) {
            yield* Effect.promise(() => fs.rm(path, { force: true }))
            removed++
          }
        }
        return removed
      })
    })
  })
)

/** Entries skipped by the zip extraction, kept in the work area until the scan reports them. */
const SkippedEntries = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      kind: Schema.Literal("excluded"),
      path: Schema.String,
      reason: ExclusionReason,
      size: Schema.Int,
      isDirectory: Schema.Boolean
    })
  )
)

const fsTry = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new FsError({ operation, path: "<work area>", cause }) })

export const SourceWorkspaceLive = Layer.effect(
  SourceWorkspace,
  Effect.gen(function* () {
    const { uploadsDir, workDir } = yield* StorageConfig
    const area = (jobId: JobId) => {
      const root = nodePath.join(workDir, jobId)
      return { root, source: nodePath.join(root, "src"), skipped: nodePath.join(root, "skipped.json") }
    }
    return SourceWorkspace.of({
      reset: (jobId) =>
        fsTry("workspace reset", async () => {
          await fs.rm(area(jobId).root, { recursive: true, force: true })
          await fs.mkdir(area(jobId).source, { recursive: true, mode: 0o700 })
        }),
      exists: (jobId) => exists(area(jobId).source),
      extractZip: Effect.fnUntraced(function* (jobId, uploadId, limits) {
        const summary = yield* extractZip(uploadPath(uploadsDir, uploadId), area(jobId).source, limits)
        const skipped: Array<SourceEntry & { readonly kind: "excluded" }> = summary.skipped.map((entry) => ({
          kind: "excluded",
          path: entry.path,
          reason: entry.reason,
          size: entry.size,
          isDirectory: false
        }))
        const encoded = yield* Schema.encodeEffect(SkippedEntries)(skipped).pipe(Effect.orDie)
        yield* fsTry("write skipped entries", () => fs.writeFile(area(jobId).skipped, encoded))
        return { rejectedUnsafePaths: summary.rejectedUnsafePaths }
      }),
      clone: (jobId, request) =>
        cloneRepository({
          url: request.url,
          ref: request.ref ?? undefined,
          username: request.username ?? undefined,
          token: request.token,
          directory: area(jobId).source,
          allowHttp: request.allowHttp,
          timeout: request.timeout
        }).pipe(Effect.map((result) => ({ commit: result.commit }))),
      scan: Effect.fnUntraced(function* (jobId, limits, onEntry) {
        const json = yield* Effect.promise(() => fs.readFile(area(jobId).skipped, "utf8").catch(() => "[]"))
        const skipped = yield* Schema.decodeUnknownEffect(SkippedEntries)(json).pipe(
          Effect.mapError((cause) => new FsError({ operation: "read skipped entries", path: "<work area>", cause }))
        )
        return yield* scanTree(area(jobId).source, limits, skipped, onEntry)
      }),
      remove: (jobId) => Effect.promise(() => fs.rm(area(jobId).root, { recursive: true, force: true }))
    })
  })
)

/** Uploads, work areas and zip writing on the local file system, with their configuration. */
export const FileAdaptersLive = Layer.mergeAll(UploadStoreLive, SourceWorkspaceLive).pipe(
  Layer.provideMerge(StorageConfig.layer)
)
