/**
 * Pure helpers of the incremental update (phase 6): what changed between two
 * versions of the code, which summaries can be reused and how the feature map
 * of the previous version is carried over.
 */
import { dirname } from "../../domain/source/paths.ts"
import type { FeatureSymbol } from "../../domain/model.ts"
import type { Declaration, NewFeature } from "../../ports/outbound/repositories.ts"
import { featureKey } from "../../domain/features.ts"
import { dedupeFeatures } from "./features.ts"

export interface FileHash {
  readonly path: string
  readonly contentHash: string
}

/** Included files of two versions compared by path and hash of the masked content. */
export interface FileChanges {
  readonly added: ReadonlyArray<string>
  readonly modified: ReadonlyArray<string>
  readonly removed: ReadonlyArray<string>
  readonly unchanged: ReadonlyArray<string>
}

export const diffFiles = (base: ReadonlyArray<FileHash>, next: ReadonlyArray<FileHash>): FileChanges => {
  const before = new Map(base.map((file) => [file.path, file.contentHash]))
  const after = new Set(next.map((file) => file.path))
  const added: Array<string> = []
  const modified: Array<string> = []
  const unchanged: Array<string> = []
  for (const file of next) {
    const previous = before.get(file.path)
    if (previous === undefined) added.push(file.path)
    else if (previous === file.contentHash) unchanged.push(file.path)
    else modified.push(file.path)
  }
  const removed = base.filter((file) => !after.has(file.path)).map((file) => file.path)
  const sorted = (paths: Array<string>) => paths.sort((a, b) => a.localeCompare(b))
  return { added: sorted(added), modified: sorted(modified), removed: sorted(removed), unchanged: sorted(unchanged) }
}

/** Paths that are new, modified or gone. */
export const changedPaths = (changes: FileChanges): ReadonlySet<string> =>
  new Set([...changes.added, ...changes.modified, ...changes.removed])

/**
 * Directories whose subtree contains a changed path (the root included): their
 * module summaries must be written again. Every other module has the same files
 * with the same content, so its summary can be copied.
 */
export const dirtyModules = (paths: Iterable<string>): ReadonlySet<string> => {
  const dirty = new Set<string>()
  for (const path of paths) {
    let current = dirname(path)
    for (;;) {
      const dir = current === "." ? "" : current
      if (dirty.has(dir)) break
      dirty.add(dir)
      if (dir === "") break
      current = dirname(dir)
    }
  }
  return dirty
}

interface MappedFeature {
  readonly name: string
  readonly description: string
  readonly files: ReadonlyArray<string>
  readonly symbols: ReadonlyArray<FeatureSymbol>
}

/**
 * Features of the previous version, restricted to files and declarations that
 * still exist; features left without files are dropped.
 */
export const carryFeatures = (
  features: ReadonlyArray<MappedFeature>,
  known: { readonly files: ReadonlySet<string>; readonly declarations: ReadonlyArray<Declaration> }
): Array<NewFeature> => {
  const declared = new Set(known.declarations.map((d) => `${d.path}\u0000${d.qualifiedName}`))
  return features.flatMap((feature) => {
    const files = feature.files.filter((path) => known.files.has(path))
    if (files.length === 0) return []
    const symbols = feature.symbols.filter(
      (symbol) => files.includes(symbol.path) && declared.has(`${symbol.path}\u0000${symbol.qualifiedName}`)
    )
    return [{ name: feature.name, description: feature.description, files, symbols }]
  })
}

/**
 * Applies the answer of the feature update: features with the name of a
 * carried one add their files to it (name and description stay); the others
 * are new features, after the carried ones.
 */
export const applyFeatureUpdate = (
  carried: ReadonlyArray<NewFeature>,
  proposed: ReadonlyArray<NewFeature>
): Array<NewFeature> => {
  const result = carried.map((feature) => ({
    ...feature,
    files: [...feature.files],
    symbols: [...feature.symbols]
  }))
  const byKey = new Map(result.map((feature) => [featureKey(feature.name), feature]))
  const added: Array<NewFeature> = []
  for (const feature of proposed) {
    const existing = byKey.get(featureKey(feature.name))
    if (existing === undefined) {
      added.push(feature)
      continue
    }
    for (const path of feature.files) if (!existing.files.includes(path)) existing.files.push(path)
    for (const symbol of feature.symbols) {
      if (!existing.symbols.some((s) => s.path === symbol.path && s.qualifiedName === symbol.qualifiedName)) {
        existing.symbols.push(symbol)
      }
    }
  }
  return [...result, ...dedupeFeatures(added)]
}

/**
 * Whether the card of a feature must be written again: its files changed, or
 * the set of its files did.
 */
export const featureAffected = (
  previous: { readonly files: ReadonlyArray<string> },
  next: { readonly files: ReadonlyArray<string> },
  changed: ReadonlySet<string>
): boolean => {
  const before = new Set(previous.files)
  return (
    before.size !== next.files.length ||
    next.files.some((path) => !before.has(path) || changed.has(path)) ||
    previous.files.some((path) => changed.has(path))
  )
}

/** Files of a feature (previous and current) that changed, for the card prompt. */
export const featureChangedFiles = (
  previous: { readonly files: ReadonlyArray<string> },
  next: { readonly files: ReadonlyArray<string> },
  changed: ReadonlySet<string>
): Array<string> => {
  const before = new Set(previous.files)
  const after = new Set(next.files)
  return [...new Set([...previous.files, ...next.files])]
    .filter((path) => changed.has(path) || !before.has(path) || !after.has(path))
    .sort((a, b) => a.localeCompare(b))
}
