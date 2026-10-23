import { Schema } from "effect"

/** The archive is malformed, encrypted or uses unsupported features. */
export class ArchiveError extends Schema.TaggedError<ArchiveError>()("ArchiveError", {
  message: Schema.String
}) {}

/** One of the {@link AcquisitionLimits} was exceeded. */
export class LimitExceededError extends Schema.TaggedError<LimitExceededError>()("LimitExceededError", {
  limit: Schema.Literals(["archive_size", "total_size", "file_count"]),
  message: Schema.String
}) {}

/** Cloning or reading a Git repository failed. The message never contains credentials. */
export class GitError extends Schema.TaggedError<GitError>()("GitError", {
  reason: Schema.Literals(["auth", "not_found", "network", "timeout", "invalid_url", "other"]),
  message: Schema.String
}) {}

/** A local filesystem operation failed. */
export class FsError extends Schema.TaggedError<FsError>()("FsError", {
  operation: Schema.String,
  path: Schema.String,
  cause: Schema.Defect()
}) {}
