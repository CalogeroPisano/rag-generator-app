import { Schema } from "effect"

/** Why a file (or a whole directory) was left out of the analysis. */
export const ExclusionReason = Schema.Literals([
  "dependency",
  "build_output",
  "vcs",
  "tooling",
  "lockfile",
  "minified",
  "source_map",
  "generated",
  "binary",
  "too_large",
  "symlink",
  "sensitive_file",
  "unreadable"
])
export type ExclusionReason = typeof ExclusionReason.Type
