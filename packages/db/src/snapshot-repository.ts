import type { PreparedFile } from "@code-to-rag/analysis"
import { NotFoundError, SnapshotRepository, UploadId, type SnapshotId } from "@code-to-rag/core"
import { and, asc, eq, isNotNull, ne, sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Database, query } from "./client.ts"
import { decodeFileContent, decodeFileEntries, snapshotFromRow } from "./rows.ts"
import { snapshot, sourceBlob, sourceFile } from "./schema/app.ts"

/** Keeps a single INSERT of blobs well below Postgres' message size limits. */
const MAX_BLOB_BATCH_CHARS = 8 * 1024 * 1024

const chunkBySize = <A>(items: ReadonlyArray<A>, size: (item: A) => number, max: number) => {
  const chunks: Array<Array<A>> = []
  let current: Array<A> = []
  let currentSize = 0
  for (const item of items) {
    if (current.length > 0 && currentSize + size(item) > max) {
      chunks.push(current)
      current = []
      currentSize = 0
    }
    current.push(item)
    currentSize += size(item)
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

export const SnapshotRepositoryLive = Layer.effect(
  SnapshotRepository,
  Effect.gen(function* () {
    const { db } = yield* Database

    const update = (operation: string, id: SnapshotId, values: Partial<typeof snapshot.$inferInsert>) =>
      query(operation, () => db.update(snapshot).set(values).where(eq(snapshot.id, id))).pipe(Effect.asVoid)

    return SnapshotRepository.of({
      get: Effect.fnUntraced(function* (id) {
        const rows = yield* query("snapshot.get", () => db.select().from(snapshot).where(eq(snapshot.id, id)))
        const row = rows[0]
        if (row === undefined) return yield* new NotFoundError({ entity: "snapshot", id })
        return {
          snapshot: yield* snapshotFromRow(row),
          uploadId: row.uploadId === null ? null : UploadId.make(row.uploadId)
        }
      }),

      setStatus: (id, status) => update("snapshot.setStatus", id, { status }),

      setCommit: (id, commitSha) => update("snapshot.setCommit", id, { commitSha }),

      clearFiles: (id) =>
        query("snapshot.clearFiles", () => db.delete(sourceFile).where(eq(sourceFile.snapshotId, id))).pipe(
          Effect.asVoid
        ),

      insertFiles: (id, files: ReadonlyArray<PreparedFile>) =>
        query("snapshot.insertFiles", () =>
          db.transaction(async (tx) => {
            const blobs = files.flatMap((file) =>
              file.contentHash === undefined || file.content === undefined
                ? []
                : [{ hash: file.contentHash, content: file.content }]
            )
            for (const chunk of chunkBySize(blobs, (blob) => blob.content.length, MAX_BLOB_BATCH_CHARS)) {
              await tx.insert(sourceBlob).values(chunk).onConflictDoNothing()
            }
            if (files.length === 0) return
            await tx
              .insert(sourceFile)
              .values(
                files.map((file) => ({
                  snapshotId: id,
                  path: file.path,
                  language: file.language,
                  size: file.size,
                  isDirectory: file.isDirectory,
                  excludedReason: file.excluded ?? null,
                  contentHash: file.contentHash ?? null,
                  lineCount: file.lineCount,
                  encoding: file.encoding ?? null,
                  secrets: [...file.secrets]
                }))
              )
              .onConflictDoNothing()
          })
        ).pipe(Effect.asVoid),

      saveScan: (id, result) =>
        update("snapshot.saveScan", id, {
          includedFiles: result.includedFiles,
          excludedFiles: result.excludedFiles,
          maskedSecrets: result.maskedSecrets,
          ...(result.contentHash === null ? {} : { contentHash: result.contentHash })
        }),

      listFiles: (id) =>
        query("snapshot.listFiles", () =>
          db
            .select({
              path: sourceFile.path,
              language: sourceFile.language,
              size: sourceFile.size,
              isDirectory: sourceFile.isDirectory,
              excludedReason: sourceFile.excludedReason,
              lineCount: sourceFile.lineCount,
              secretCount: sql<number>`jsonb_array_length(${sourceFile.secrets})`.mapWith(Number),
              parseErrors: sourceFile.parseErrors
            })
            .from(sourceFile)
            .where(eq(sourceFile.snapshotId, id))
            .orderBy(asc(sourceFile.path))
        ).pipe(Effect.flatMap(decodeFileEntries)),

      getFileContent: Effect.fnUntraced(function* (id, path) {
        const rows = yield* query("snapshot.getFileContent", () =>
          db
            .select({
              path: sourceFile.path,
              language: sourceFile.language,
              content: sourceBlob.content,
              secrets: sourceFile.secrets
            })
            .from(sourceFile)
            .innerJoin(sourceBlob, eq(sourceBlob.hash, sourceFile.contentHash))
            .where(and(eq(sourceFile.snapshotId, id), eq(sourceFile.path, path)))
        )
        const row = rows[0]
        if (row === undefined) return yield* new NotFoundError({ entity: "file", id: path })
        return yield* decodeFileContent(row)
      }),

      pendingUploadIds: query("snapshot.pendingUploadIds", () =>
        db
          .select({ uploadId: snapshot.uploadId })
          .from(snapshot)
          .where(and(isNotNull(snapshot.uploadId), ne(snapshot.status, "ready")))
      ).pipe(Effect.map((rows) => rows.flatMap((row) => (row.uploadId === null ? [] : [UploadId.make(row.uploadId)]))))
    })
  })
)
