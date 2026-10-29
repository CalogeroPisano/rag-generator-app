import { ZipArchive, type ZipWriter } from "@code-to-rag/core/outbound"
import { Effect, Layer } from "effect"
import { Zip, ZipDeflate } from "fflate"

/**
 * Adapter of the `ZipArchive` port with fflate. `ZipDeflate` compresses
 * synchronously: the output of every push is collected and handed to `write`
 * before the next piece arrives, so the archive is never held whole.
 */
const makeWriter = <E, R>(write: (bytes: Uint8Array) => Effect.Effect<void, E, R>): ZipWriter<E, R> => {
  const output: Array<Uint8Array> = []
  let failure: Error | null = null
  const zip = new Zip((error, data) => {
    if (error !== null) failure = error
    else output.push(data)
  })
  const flush = Effect.suspend(() => {
    if (failure !== null) return Effect.die(failure)
    return Effect.forEach(output.splice(0), write, { discard: true })
  })
  const mtime = new Date()
  return {
    file: (name) => {
      const entry = new ZipDeflate(name, { level: 6 })
      entry.mtime = mtime
      zip.add(entry)
      return {
        push: (content) => Effect.suspend(() => (entry.push(content), flush)),
        end: Effect.suspend(() => (entry.push(new Uint8Array(0), true), flush))
      }
    },
    end: Effect.suspend(() => (zip.end(), flush))
  }
}

export const ZipArchiveLive = Layer.succeed(ZipArchive, ZipArchive.of({ writer: makeWriter }))
