/**
 * Directory of a relative POSIX path of the snapshot (`"."` for a top-level file), as `path.posix.dirname` gives
 * it for the normalised paths stored at ingestion (no trailing or repeated slashes).
 */
export const dirname = (path: string): string => {
  const index = path.lastIndexOf("/")
  return index === -1 ? "." : index === 0 ? "/" : path.slice(0, index)
}
