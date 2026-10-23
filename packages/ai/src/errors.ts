import { Schema } from "effect"

export const AiErrorKind = Schema.Literals(["not_configured", "timeout", "provider", "invalid_output"])
export type AiErrorKind = typeof AiErrorKind.Type

/**
 * A model call that could not produce a valid result. `message` never contains
 * prompt or output text (they may include code), only a short description.
 */
export class AiError extends Schema.TaggedError<AiError>()("AiError", {
  kind: AiErrorKind,
  message: Schema.String,
  retryable: Schema.Boolean
}) {}
