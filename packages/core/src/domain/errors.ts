import { Schema } from "effect"

/** Unexpected database failure. The cause stays server-side and is never sent to clients. */
export class DatabaseError extends Schema.TaggedError<DatabaseError>()("DatabaseError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("NotFoundError", {
  entity: Schema.String,
  id: Schema.String
}) {}

/** The user may not do this (e.g. settings, which only administrators change). */
export class ForbiddenError extends Schema.TaggedError<ForbiddenError>()("ForbiddenError", {
  message: Schema.String
}) {}

/** Input that passed schema validation but is not acceptable (e.g. unknown upload). */
export class InvalidInputError extends Schema.TaggedError<InvalidInputError>()("InvalidInputError", {
  message: Schema.String
}) {}

export class EncryptionError extends Schema.TaggedError<EncryptionError>()("EncryptionError", {
  message: Schema.String
}) {}

/** A pipeline phase failed. `retryable: false` means retrying cannot help (bad input, limits, auth). */
export class PhaseError extends Schema.TaggedError<PhaseError>()("PhaseError", {
  phase: Schema.String,
  message: Schema.String,
  retryable: Schema.Boolean
}) {}

// ── Source acquisition (raised by the source adapters, mapped by the acquisition pipeline) ──

/** The archive is malformed, encrypted or uses unsupported features. */
export class ArchiveError extends Schema.TaggedError<ArchiveError>()("ArchiveError", {
  message: Schema.String
}) {}

/** One of the acquisition limits (`AcquisitionLimits`) was exceeded. */
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
