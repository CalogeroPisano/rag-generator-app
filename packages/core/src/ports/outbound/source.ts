/**
 * Source ports: the uploaded archives and the per-job work area where the code
 * is fetched (zip extraction or Git clone) and read back. Implemented by
 * `@code-to-rag/filesystem` on the local file system (`DATA_DIR`).
 */
import { Context, type Duration, type Effect, type Redacted } from "effect"
import type { ArchiveError, FsError, GitError, LimitExceededError } from "../../domain/errors.ts"
import type { JobId, UploadId } from "../../domain/model.ts"
import type { ExclusionReason } from "../../domain/source/exclusion.ts"
import type { AcquisitionLimits } from "../../domain/source/limits.ts"

/** What a scan of the work area finds: a file with its original bytes, or an entry excluded without reading it. */
export type SourceEntry =
  | { readonly kind: "file"; readonly path: string; readonly bytes: Uint8Array }
  | {
      readonly kind: "excluded"
      readonly path: string
      readonly reason: ExclusionReason
      readonly size: number
      readonly isDirectory: boolean
    }

export interface CloneRequest {
  readonly url: string
  /** Branch or tag; the remote's default branch when null. */
  readonly ref: string | null
  readonly username: string | null
  /** Read-only access token: handed to the Git client only through its authentication callback. */
  readonly token: Redacted.Redacted | undefined
  readonly allowHttp: boolean
  readonly timeout: Duration.Duration
}

export class SourceWorkspace extends Context.Service<
  SourceWorkspace,
  {
    /** Empties the work area of a job (whatever a previous attempt left behind is removed). */
    reset(jobId: JobId): Effect.Effect<void, FsError>
    exists(jobId: JobId): Effect.Effect<boolean>
    /**
     * Extracts an uploaded archive into the work area. Entries are validated against path traversal, symbolic links
     * are never created, limits are enforced on the bytes actually produced. Entries that were not extracted are
     * reported by the next scan. Returns the number of entries rejected for unsafe paths.
     */
    extractZip(
      jobId: JobId,
      uploadId: UploadId,
      limits: AcquisitionLimits
    ): Effect.Effect<{ readonly rejectedUnsafePaths: number }, ArchiveError | LimitExceededError | FsError>
    /** Shallow clone of one branch into the work area; returns the commit. */
    clone(jobId: JobId, request: CloneRequest): Effect.Effect<{ readonly commit: string }, GitError | FsError>
    /**
     * Walks the work area in a deterministic order, never following symbolic links, handing every entry to
     * `onEntry` (excluded directories once, not descended into). `treeHash` identifies the original tree (paths
     * and bytes) without revealing it.
     */
    scan<E, R>(
      jobId: JobId,
      limits: AcquisitionLimits,
      onEntry: (entry: SourceEntry) => Effect.Effect<void, E, R>
    ): Effect.Effect<{ readonly treeHash: string }, FsError | LimitExceededError | E, R>
    /** Deletes the work area (the original code). */
    remove(jobId: JobId): Effect.Effect<void>
  }
>()("code-to-rag/core/SourceWorkspace") {}

/** How a received upload ended: stored, or refused while it was being read. */
export type ReceivedUpload =
  { readonly _tag: "stored"; readonly size: number; readonly header: Uint8Array } | { readonly _tag: "too_large" }

export class UploadStore extends Context.Service<
  UploadStore,
  {
    /**
     * Streams an upload to storage under a temporary name, stopping as soon as it exceeds `maxBytes` (the declared
     * length is not trusted); the upload exists under its id only once complete. `header` holds its first bytes.
     */
    receive(id: UploadId, body: ReadableStream<Uint8Array>, maxBytes: number): Effect.Effect<ReceivedUpload, FsError>
    exists(id: UploadId): Effect.Effect<boolean>
    remove(id: UploadId): Effect.Effect<void>
    /** Removes uploads (complete or partial) older than `olderThanMs`, except `keep`; returns how many. */
    removeStale(olderThanMs: number, keep: ReadonlySet<string>): Effect.Effect<number>
  }
>()("code-to-rag/core/UploadStore") {}
