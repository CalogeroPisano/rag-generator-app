import { Context, type Effect } from "effect"

/** A zip archive written as it is produced: files one after the other, each pushed in pieces. */
export interface ZipWriter<E, R> {
  file(name: string): {
    readonly push: (content: Uint8Array) => Effect.Effect<void, E, R>
    readonly end: Effect.Effect<void, E, R>
  }
  readonly end: Effect.Effect<void, E, R>
}

/** Zip encoder (implemented with fflate by `@code-to-rag/filesystem`). */
export class ZipArchive extends Context.Service<
  ZipArchive,
  {
    /** A writer handing the archive's bytes to `write`, in order. */
    writer<E, R>(write: (bytes: Uint8Array) => Effect.Effect<void, E, R>): ZipWriter<E, R>
  }
>()("code-to-rag/core/ZipArchive") {}
