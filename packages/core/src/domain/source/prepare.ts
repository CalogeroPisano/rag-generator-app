import { Effect } from "effect"
import type { ExclusionReason } from "./exclusion.ts"
import { classifyFileContent, classifyFilePath } from "./filters.ts"
import { detectLanguage } from "./languages.ts"
import type { AcquisitionLimits } from "./limits.ts"
import type { SecretFinding } from "../model.ts"
import { maskSecrets } from "./secrets.ts"

/** A file ready to be stored: masked content for included files, metadata only otherwise. */
export interface PreparedFile {
  readonly path: string
  readonly language: string
  readonly size: number
  readonly isDirectory: boolean
  readonly excluded: ExclusionReason | undefined
  /** Masked text; only for included files. */
  readonly content: string | undefined
  /** SHA-256 of the masked content; only for included files. */
  readonly contentHash: string | undefined
  readonly lineCount: number
  readonly encoding: "utf-8" | "windows-1252" | undefined
  readonly secrets: ReadonlyArray<SecretFinding>
}

/** SHA-256 in hex, with the Web Crypto API (a platform standard, no Node module). */
export const sha256 = (text: string): Effect.Effect<string> =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).pipe(
    Effect.map((digest) => Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""))
  )

export const excludedFile = (
  path: string,
  reason: ExclusionReason,
  size: number,
  isDirectory = false
): PreparedFile => ({
  path,
  language: isDirectory ? "directory" : detectLanguage(path),
  size,
  isDirectory,
  excluded: reason,
  content: undefined,
  contentHash: undefined,
  lineCount: 0,
  encoding: undefined,
  secrets: []
})

const decodeText = (bytes: Uint8Array): { text: string; encoding: "utf-8" | "windows-1252" } => {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes), encoding: "utf-8" }
  } catch {
    // Legacy codebases often use Windows-1252 (or Latin-1, which it extends).
    return { text: new TextDecoder("windows-1252").decode(bytes), encoding: "windows-1252" }
  }
}

/** Classifies, decodes and masks one file. No I/O: only the content hash is computed asynchronously. */
export const prepareFile = (
  path: string,
  bytes: Uint8Array,
  limits: AcquisitionLimits
): Effect.Effect<PreparedFile> => {
  const byPath = classifyFilePath(path)
  if (byPath !== undefined) return Effect.succeed(excludedFile(path, byPath, bytes.length))
  if (bytes.length > limits.maxFileBytes) return Effect.succeed(excludedFile(path, "too_large", bytes.length))
  const byContent = classifyFileContent(path, bytes)
  if (byContent !== undefined) return Effect.succeed(excludedFile(path, byContent, bytes.length))

  const { text, encoding } = decodeText(bytes)
  const language = detectLanguage(path)
  const masked = maskSecrets(text, language)
  return sha256(masked.text).pipe(
    Effect.map((contentHash): PreparedFile => ({
      path,
      language,
      size: bytes.length,
      isDirectory: false,
      excluded: undefined,
      content: masked.text,
      contentHash,
      lineCount: masked.text.length === 0 ? 0 : masked.text.split("\n").length,
      encoding,
      secrets: masked.findings
    }))
  )
}
