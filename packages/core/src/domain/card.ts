/**
 * Content of a functional card and the verdicts given on it. The field descriptions are part of the schema the
 * model receives (as JSON Schema) when it writes or checks a card.
 */
import { Schema } from "effect"

// Plain numbers: an integer schema adds ±2^53 bounds that weigh on constrained decoding. Callers round them.
export const CardReference = Schema.Struct({
  path: Schema.String.annotate({ description: "File path, exactly as shown in the input." }),
  startLine: Schema.Number,
  endLine: Schema.Number
})
export type CardReference = typeof CardReference.Type

const References = Schema.Array(CardReference).annotate({
  description: "Source lines that support the statement (at least one)."
})

export const CardStatement = Schema.Struct({
  text: Schema.String,
  references: References
})
export type CardStatement = typeof CardStatement.Type

export const CardParameter = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  type: Schema.NullOr(Schema.String).annotate({ description: "Type or accepted values, null if unknown." }),
  required: Schema.NullOr(Schema.Boolean),
  defaultValue: Schema.NullOr(Schema.String),
  references: References
})
export type CardParameter = typeof CardParameter.Type

export const CardError = Schema.Struct({
  condition: Schema.String.annotate({ description: "When the error happens." }),
  message: Schema.NullOr(Schema.String).annotate({ description: "Message shown to the user, if visible in the code." }),
  references: References
})
export type CardError = typeof CardError.Type

/** Structured content of a card (also the stored form, once references are checked). */
export const CardContent = Schema.Struct({
  title: Schema.String,
  summary: Schema.String.annotate({ description: "Two or three sentences for an end user." }),
  behavior: Schema.Array(CardStatement).annotate({ description: "What the feature does, step by step." }),
  configuration: Schema.Array(CardStatement).annotate({ description: "How it is enabled or configured." }),
  parameters: Schema.Array(CardParameter).annotate({ description: "Inputs, options and settings." }),
  limits: Schema.Array(CardStatement).annotate({ description: "Limits: sizes, quotas, timeouts, permissions." }),
  validationRules: Schema.Array(CardStatement).annotate({ description: "Rules the input must satisfy." }),
  errors: Schema.Array(CardError)
})
export type CardContent = typeof CardContent.Type

export const CARD_SECTIONS = ["behavior", "configuration", "parameters", "limits", "validationRules", "errors"] as const
export type CardSection = (typeof CARD_SECTIONS)[number]

export const CardSectionName = Schema.Literals(CARD_SECTIONS)

/** Verdict of the automatic verification on one statement of a card. */
export const StatementVerdict = Schema.Literals(["supported", "partial", "unsupported"])
export type StatementVerdict = typeof StatementVerdict.Type

/** Verdict of the model judging a chat answer in a test run. */
export const AnswerVerdict = Schema.Literals(["correct", "partial", "incorrect", "no_answer"])
export type AnswerVerdict = typeof AnswerVerdict.Type
