/**
 * Model ports: the chat/structured language model, the decision model, the
 * embedding model and the model call log. Implemented by `@code-to-rag/openai`
 * (OpenAI-compatible endpoint), `@code-to-rag/ollama` (decision model) and, for
 * the log, by `@code-to-rag/postgres`.
 */
import { Context, type Effect, Schema } from "effect"

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

/** A versioned prompt: changing the text of a prompt means bumping its version. */
export interface PromptRef {
  readonly id: string
  readonly version: number
}

// ── Model call log ─────────────────────────────────────────────────────────

export const ModelCallOutcome = Schema.Literals(["success", "invalid_output", "error", "timeout"])
export type ModelCallOutcome = typeof ModelCallOutcome.Type

/** Who asked for a model call: copied into the call log. */
export interface ModelCallContext {
  readonly phase: string
  readonly jobId?: string | undefined
  readonly snapshotId?: string | undefined
}

/**
 * One HTTP call to a model, as recorded in the call log. Metadata only: the
 * prompt and the output are never recorded (they contain source code).
 */
export interface ModelCall extends ModelCallContext {
  /** Prompt id, e.g. `file-summary`. */
  readonly task: string
  readonly promptVersion: number
  readonly provider: string
  readonly model: string
  /** 1 for the first call, 2 for the correction request after an invalid output. */
  readonly attempt: number
  readonly outcome: ModelCallOutcome
  readonly durationMs: number
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  /** Short error description (error name, HTTP status); never response bodies. */
  readonly error: string | null
}

/** Sink of the model call log. */
export class ModelCallRecorder extends Context.Service<
  ModelCallRecorder,
  {
    record(call: ModelCall): Effect.Effect<void>
  }
>()("code-to-rag/core/ModelCallRecorder") {}

// ── Language model ─────────────────────────────────────────────────────────

export type OutputSchema = Schema.Top & { readonly DecodingServices: never }

export interface StructuredRequest<S extends OutputSchema> {
  readonly prompt: PromptRef
  readonly context: ModelCallContext
  readonly instructions: string
  /** User message. It may contain (masked) source code: it is never logged. */
  readonly input: string
  /** Output schema: sent to the model as JSON Schema and used to validate the answer. */
  readonly schema: S
  readonly maxOutputTokens?: number | undefined
}

export interface TextRequest {
  readonly prompt: PromptRef
  readonly context: ModelCallContext
  readonly instructions: string
  /** Conversation, ending with the user message. It may contain card text: it is never logged. */
  readonly messages: ReadonlyArray<{ readonly role: "user" | "assistant"; readonly content: string }>
  readonly maxOutputTokens?: number | undefined
  /** Receives the answer while it is generated. Once text has been delivered the call is not retried. */
  readonly onDelta?: ((delta: string) => void) | undefined
}

export interface TextAnswer {
  readonly text: string
  /** The model stopped at the output token limit. */
  readonly truncated: boolean
}

export interface LanguageModelShape {
  /** Model id, recorded with every generated artifact; undefined when no model is configured. */
  readonly modelId: string | undefined
  /** Token budget of a single call (input + output). */
  readonly contextTokens: number
  readonly maxOutputTokens: number
  /** Output limit of a text (chat) answer. */
  readonly chatMaxOutputTokens: number
  /**
   * Asks for a structured answer. An answer that does not match the schema gets
   * one correction request; if that is invalid too, fails with `invalid_output`.
   */
  generateObject<S extends OutputSchema>(request: StructuredRequest<S>): Effect.Effect<S["Type"], AiError>
  /** Asks for a plain text answer (chat), always streamed. */
  generateText(request: TextRequest): Effect.Effect<TextAnswer, AiError>
}

export class LanguageModel extends Context.Service<LanguageModel, LanguageModelShape>()(
  "code-to-rag/core/LanguageModel"
) {}

// ── Decision model  ────────────────────────────────────────────────────────

/** A yes/no question about the state of a decision request. */
export interface DecisionQuestion {
  readonly instructions: string
  /** Optional descriptions of what "true" and "false" mean. */
  readonly criteria?: { readonly true?: string; readonly false?: string } | undefined
}

export interface DecisionRequest {
  /** Version of the questions (recorded in the call log like a prompt version). */
  readonly prompt: PromptRef
  readonly context: ModelCallContext
  /** Context shared by every question. It may contain (masked) source code: it is never logged. */
  readonly state: string
  /** Questions by name (ASCII letters, digits, `_`, `.`, `-`), at most `maxQuestions`. */
  readonly questions: Readonly<Record<string, DecisionQuestion>>
}

export interface DecisionModelShape {
  /** Model id, recorded with every decision. */
  readonly modelId: string
  /** Token budget of one request (state and questions). */
  readonly contextTokens: number
  /** Questions answered by one request. */
  readonly maxQuestions: number
  /**
   * Answers every question in one pass, without generating text: the probability (0–1) that the answer is "true",
   * by question name.
   */
  decide(request: DecisionRequest): Effect.Effect<Readonly<Record<string, number>>, AiError>
}

/** Decision model (System One API): probabilities of typed answers, no generated text. */
export class DecisionModel extends Context.Service<DecisionModel, DecisionModelShape>()(
  "code-to-rag/core/DecisionModel"
) {}

// ── Embedding model ────────────────────────────────────────────────────────

export interface EmbeddingRequest {
  /** Version of the text format being embedded (recorded in the call log like a prompt version). */
  readonly format: PromptRef
  readonly context: ModelCallContext
  /** Texts to embed (card chunks or a question): never logged. */
  readonly texts: ReadonlyArray<string>
}

export interface EmbeddingModelShape {
  /** Model id, stored with every vector; undefined when embeddings are not configured. */
  readonly modelId: string | undefined
  /** One vector per text, in the same order. */
  embed(request: EmbeddingRequest): Effect.Effect<ReadonlyArray<ReadonlyArray<number>>, AiError>
}

export class EmbeddingModel extends Context.Service<EmbeddingModel, EmbeddingModelShape>()(
  "code-to-rag/core/EmbeddingModel"
) {}
