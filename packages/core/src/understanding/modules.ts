/**
 * Modules for the bottom-up summaries: directories that hold summarized files
 * or join several sub-modules. A directory with a single sub-directory and no
 * files of its own is skipped (its sub-module rises to the parent), so that
 * deep package paths (`src/main/java/com/acme/…`) do not produce empty levels.
 */
import * as posix from "node:path/posix"

export interface ModulePlan {
  /** Directory path; "" for the project root. */
  readonly path: string
  readonly depth: number
  /** Summarized files directly in the directory. */
  readonly files: ReadonlyArray<string>
  /** Nearest modules below this one. */
  readonly modules: ReadonlyArray<string>
  /** Summarized files in the whole subtree. */
  readonly fileCount: number
}

const parentOf = (path: string): string => {
  const parent = posix.dirname(path)
  return parent === "." ? "" : parent
}

const depthOf = (path: string): number => (path === "" ? 0 : path.split("/").length)

/** Modules to summarize, deepest first (each module comes after the modules below it). */
export const planModules = (filePaths: ReadonlyArray<string>): ReadonlyArray<ModulePlan> => {
  const files = new Map<string, Array<string>>()
  const children = new Map<string, Set<string>>()
  const subtreeFiles = new Map<string, number>()
  for (const path of filePaths) {
    const dir = parentOf(path)
    files.set(dir, [...(files.get(dir) ?? []), path])
    // Register the directory chain up to the root.
    let current = dir
    for (;;) {
      subtreeFiles.set(current, (subtreeFiles.get(current) ?? 0) + 1)
      if (current === "") break
      const parent = parentOf(current)
      children.set(parent, (children.get(parent) ?? new Set()).add(current))
      current = parent
    }
  }

  const isModule = (dir: string): boolean =>
    dir === "" || (files.get(dir)?.length ?? 0) > 0 || (children.get(dir)?.size ?? 0) > 1

  /** Nearest module directories below `dir`, looking through skipped directories. */
  const modulesBelow = (dir: string): Array<string> =>
    [...(children.get(dir) ?? [])].flatMap((child) => (isModule(child) ? [child] : modulesBelow(child)))

  return [...subtreeFiles.keys()]
    .filter(isModule)
    .map((path) => ({
      path,
      depth: depthOf(path),
      files: [...(files.get(path) ?? [])].sort(),
      modules: modulesBelow(path).sort(),
      fileCount: subtreeFiles.get(path) ?? 0
    }))
    .sort((a, b) => b.depth - a.depth || a.path.localeCompare(b.path))
}
