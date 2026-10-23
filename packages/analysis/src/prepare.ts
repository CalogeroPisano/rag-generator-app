import { createHash } from "node:crypto"
import type { ExclusionReason } from "./exclusion.ts"
import { classifyFileContent, classifyFilePath } from "./filters.ts"
import { detectLanguage } from "./languages.ts"
import type { AcquisitionLimits } from "./limits.ts"
import { maskSecrets, type SecretFinding } from "./secrets.ts"

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

export const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex")

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

/** Classifies, decodes and masks one file. Pure: no I/O. */
export const prepareFile = (path: string, bytes: Uint8Array, limits: AcquisitionLimits): PreparedFile => {
  const byPath = classifyFilePath(path)
  if (byPath !== undefined) return excludedFile(path, byPath, bytes.length)
  if (bytes.length > limits.maxFileBytes) return excludedFile(path, "too_large", bytes.length)
  const byContent = classifyFileContent(path, bytes)
  if (byContent !== undefined) return excludedFile(path, byContent, bytes.length)

  const { text, encoding } = decodeText(bytes)
  const language = detectLanguage(path)
  const masked = maskSecrets(text, language)
  return {
    path,
    language,
    size: bytes.length,
    isDirectory: false,
    excluded: undefined,
    content: masked.text,
    contentHash: sha256(masked.text),
    lineCount: masked.text.length === 0 ? 0 : masked.text.split("\n").length,
    encoding,
    secrets: masked.findings
  }
}
