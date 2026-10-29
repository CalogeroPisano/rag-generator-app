/**
 * Turns the feature lists produced by the model into features that only
 * reference files and declarations that exist in the snapshot.
 */
import type { FeatureMapOutput, FeatureMergeOutput } from "../prompts/features.ts"
import type { FeatureSymbol } from "../../domain/model.ts"
import type { Declaration, NewFeature } from "../../ports/outbound/repositories.ts"

const normalizePath = (path: string): string => path.trim().replace(/^\.?\//, "")

const lastSegment = (qualifiedName: string): string => qualifiedName.slice(qualifiedName.lastIndexOf(".") + 1)

const unique = <A>(items: ReadonlyArray<A>, key: (item: A) => string): Array<A> => {
  const seen = new Set<string>()
  return items.filter((item) => {
    const k = key(item)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

const symbolKey = (symbol: FeatureSymbol) => `${symbol.path}\u0000${symbol.qualifiedName}`

export const normalizeFeatures = (
  features: FeatureMapOutput["features"],
  known: { readonly files: ReadonlySet<string>; readonly declarations: ReadonlyArray<Declaration> }
): Array<NewFeature> => {
  const byPath = new Map<string, Array<Declaration>>()
  for (const declaration of known.declarations) {
    byPath.set(declaration.path, [...(byPath.get(declaration.path) ?? []), declaration])
  }
  return features.flatMap((feature) => {
    const files = unique(feature.files.map(normalizePath), (path) => path).filter((path) => known.files.has(path))
    const name = feature.name.trim()
    if (files.length === 0 || name === "") return []
    // Declarations are matched by qualified name, or by simple name, within the files of the feature.
    const symbols = unique(
      feature.symbols.flatMap((wanted) => {
        const target = wanted.trim()
        return files.flatMap((path) =>
          (byPath.get(path) ?? [])
            .filter((d) => d.qualifiedName === target || lastSegment(d.qualifiedName) === target)
            .map((d) => ({ path, qualifiedName: d.qualifiedName }))
        )
      }),
      symbolKey
    )
    return [{ name, description: feature.description.trim(), files, symbols }]
  })
}

/** Applies the merge answer: candidates it does not mention are kept as they are. */
export const mergeFeatures = (candidates: ReadonlyArray<NewFeature>, merge: FeatureMergeOutput): Array<NewFeature> => {
  const used = new Set<number>()
  const merged = merge.features.flatMap((feature) => {
    const members = unique(
      feature.candidates.map((n) => Math.round(n) - 1).filter((i) => i >= 0 && i < candidates.length && !used.has(i)),
      String
    )
    if (members.length === 0) return []
    for (const i of members) used.add(i)
    const parts = members.map((i) => candidates[i] as NewFeature)
    return [
      {
        name: feature.name.trim() || (parts[0]?.name ?? ""),
        description: feature.description.trim() || (parts[0]?.description ?? ""),
        files: unique(
          parts.flatMap((p) => p.files),
          (path) => path
        ),
        symbols: unique(
          parts.flatMap((p) => p.symbols),
          symbolKey
        )
      }
    ]
  })
  return [...merged, ...candidates.filter((_, i) => !used.has(i))]
}

/** Features with the same name (case-insensitive) are joined. */
export const dedupeFeatures = (features: ReadonlyArray<NewFeature>): Array<NewFeature> => {
  const byName = new Map<string, NewFeature>()
  for (const feature of features) {
    const key = feature.name.toLowerCase()
    const existing = byName.get(key)
    byName.set(
      key,
      existing === undefined
        ? feature
        : {
            ...existing,
            files: unique([...existing.files, ...feature.files], (path) => path),
            symbols: unique([...existing.symbols, ...feature.symbols], symbolKey)
          }
    )
  }
  return [...byName.values()]
}
