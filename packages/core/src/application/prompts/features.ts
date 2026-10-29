/**
 * Feature map: the features of the application, each with the files and
 * symbols that implement it. Large projects are mapped in batches of modules,
 * then the candidate features are merged.
 */
import { Schema } from "effect"
import type { PromptRef } from "../../ports/outbound/models.ts"
import { COMMON_RULES, truncate } from "./format.ts"

export const FEATURE_MAP: PromptRef = { id: "feature-map", version: 1 }

export const FeatureMapOutput = Schema.Struct({
  features: Schema.Array(
    Schema.Struct({
      name: Schema.String.annotate({ description: "Short name of the feature, as a user would call it." }),
      description: Schema.String.annotate({ description: "One or two sentences: what the user can do with it." }),
      files: Schema.Array(Schema.String).annotate({
        description: "Paths of the files that implement the feature, exactly as listed."
      }),
      symbols: Schema.Array(Schema.String).annotate({
        description: "Qualified names of the main declarations involved, exactly as listed (may be empty)."
      })
    })
  )
})
export type FeatureMapOutput = typeof FeatureMapOutput.Type

export const featureMapInstructions = [
  "You document a software application for its end users, starting from its source code.",
  "List the features of the application: things a user (or an administrator configuring it) can do or must know.",
  "Group technical pieces into user-level features; ignore build scripts, tests and pure infrastructure.",
  "For each feature, list the files that implement it, so that its documentation can be written from them.",
  "Use only file paths and declaration names that appear in the input.",
  COMMON_RULES
].join("\n")

/** Maximum characters of each file summary in the feature map prompt. */
export const FEATURE_MAP_FILE_CHARS = 240

export interface FeatureMapFile {
  readonly path: string
  readonly summary: string
  readonly symbols: ReadonlyArray<string>
}

export const renderFeatureMapFile = (file: FeatureMapFile): string => {
  const symbols = file.symbols.length === 0 ? "" : ` [declarations: ${file.symbols.join(", ")}]`
  return `- ${file.path}: ${truncate(file.summary, FEATURE_MAP_FILE_CHARS)}${symbols}`
}

export const renderFeatureMap = (input: {
  readonly projectSummary: string | null
  readonly modules: ReadonlyArray<{ readonly path: string; readonly summary: string }>
  /** Pre-rendered with `renderFeatureMapFile`, so that callers can size batches. */
  readonly files: ReadonlyArray<string>
  /** Set when the project is mapped in several batches. */
  readonly batch: { readonly index: number; readonly count: number } | null
}): string =>
  [
    ...(input.projectSummary === null ? [] : ["Application overview:", input.projectSummary, ""]),
    ...(input.batch === null
      ? []
      : [
          `This is part ${input.batch.index} of ${input.batch.count} of the application: list the features implemented by these files.`,
          ""
        ]),
    "Modules:",
    ...input.modules.map((module) => `- ${module.path === "" ? "(root)" : `${module.path}/`}: ${module.summary}`),
    "",
    "Files:",
    ...input.files
  ].join("\n")

// ---------------------------------------------------------------------------

export const FEATURE_MERGE: PromptRef = { id: "feature-merge", version: 1 }

export const FeatureMergeOutput = Schema.Struct({
  features: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      description: Schema.String,
      candidates: Schema.Array(Schema.Number).annotate({
        description: "Numbers of the candidate features merged into this one."
      })
    })
  )
})
export type FeatureMergeOutput = typeof FeatureMergeOutput.Type

export const featureMergeInstructions = [
  "You document a software application for its end users.",
  "Different parts of the application were analyzed separately and produced candidate features.",
  "Merge the candidates that describe the same feature; keep distinct features separate.",
  "Every candidate number must appear in exactly one feature.",
  COMMON_RULES
].join("\n")

export const renderFeatureMerge = (
  candidates: ReadonlyArray<{ readonly name: string; readonly description: string; readonly files: number }>
): string =>
  [
    "Candidate features:",
    ...candidates.map(
      (candidate, index) => `${index + 1}. ${candidate.name}: ${candidate.description} (${candidate.files} files)`
    )
  ].join("\n")

// ---------------------------------------------------------------------------

/**
 * Incremental update of the feature map: the existing features stay; new and
 * changed files are attached to them or form new features. The answer has the
 * same shape as the feature map.
 */
export const FEATURE_UPDATE: PromptRef = { id: "feature-update", version: 1 }

export const featureUpdateInstructions = [
  "You document a software application for its end users, starting from its source code.",
  "The application changed: some files are new or were modified. Its current features are listed.",
  "For each listed file, decide which features it implements:",
  "- for an existing feature, return it with exactly the same name and only the listed files that belong to it;",
  "- for a user-level capability that no existing feature covers, return a new feature with a short name and",
  "  description.",
  "Do not return existing features that none of the listed files belong to. Ignore build scripts, tests and pure",
  "infrastructure. Use only file paths and declaration names that appear in the input.",
  COMMON_RULES
].join("\n")

export const renderFeatureUpdate = (input: {
  readonly projectSummary: string | null
  readonly features: ReadonlyArray<{ readonly name: string; readonly description: string }>
  /** Pre-rendered with `renderFeatureMapFile`, so that callers can size batches. */
  readonly files: ReadonlyArray<string>
}): string =>
  [
    ...(input.projectSummary === null ? [] : ["Application overview:", input.projectSummary, ""]),
    "Existing features:",
    ...input.features.map((feature) => `- ${feature.name}: ${feature.description}`),
    "",
    "New or modified files:",
    ...input.files
  ].join("\n")
