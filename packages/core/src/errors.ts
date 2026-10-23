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
