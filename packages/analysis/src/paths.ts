import * as nodePath from "node:path"

/**
 * Normalises an entry name coming from an archive into a safe relative POSIX
 * path. Returns `undefined` for anything that could escape the extraction
 * root: absolute paths, drive letters, `..` segments, NUL bytes, or names that
 * normalise to nothing.
 */
export const sanitizeArchivePath = (name: string): string | undefined => {
  if (name.length === 0 || name.length > 4096 || name.includes("\0")) return undefined
  const unified = name.replaceAll("\\", "/")
  if (unified.startsWith("/") || /^[A-Za-z]:/.test(unified)) return undefined
  const segments: Array<string> = []
  for (const segment of unified.split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") return undefined
    segments.push(segment)
  }
  if (segments.length === 0) return undefined
  return segments.join("/")
}

/**
 * Resolves a sanitised relative path inside `root`, double-checking that the
 * result does not escape it.
 */
export const resolveInside = (root: string, relativePath: string): string | undefined => {
  const resolvedRoot = nodePath.resolve(root)
  const target = nodePath.resolve(resolvedRoot, relativePath)
  return target.startsWith(resolvedRoot + nodePath.sep) ? target : undefined
}
