/**
 * Model settings of the installation, edited by administrators on the settings page: OpenAI-compatible
 * connections (OpenRouter, Gemini, OpenAI, Ollama, vLLM…) with their API keys, the model of each group of tasks,
 * the embedding model and the decision model. API keys never leave the server: views only say whether one is set.
 */
import { Schema } from "effect"

/** Groups of tasks that can use different models. */
export const ModelTask = Schema.Literals(["summaries", "cards", "chat"])
export type ModelTask = typeof ModelTask.Type

export const MODEL_TASKS: ReadonlyArray<ModelTask> = ["summaries", "cards", "chat"]

export const ConnectionPreset = Schema.Literals([
  "openrouter",
  "gemini",
  "openai",
  "mistral",
  "groq",
  "ollama",
  "vllm",
  "custom"
])
export type ConnectionPreset = typeof ConnectionPreset.Type

const Name = Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(80))
const ModelId = Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(200))
const Url = Schema.Trimmed.check(Schema.isMaxLength(500), Schema.isPattern(/^https?:\/\/[^\s]+$/))
const Tokens = Schema.Int.check(Schema.isBetween({ minimum: 512, maximum: 2_000_000 }))
const OutputTokens = Schema.Int.check(Schema.isBetween({ minimum: 64, maximum: 200_000 }))

/** An OpenAI-compatible endpoint. */
export const ModelConnection = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
  name: Name,
  preset: ConnectionPreset,
  baseUrl: Url,
  /** Send the JSON schema as `response_format` (structured outputs); otherwise plain JSON mode. */
  structuredOutputs: Schema.Boolean,
  /** Calls running at the same time per model of this connection, in each process. */
  concurrency: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 64 }))
})
export type ModelConnection = typeof ModelConnection.Type

/** The model of a group of tasks. */
export const TaskModel = Schema.Struct({
  connectionId: Schema.String,
  model: ModelId,
  /** Context window of the model: prompts are sized to fit it. */
  contextTokens: Tokens,
  /** Longest structured answer (summaries, maps, cards). */
  maxOutputTokens: OutputTokens,
  /** Longest text answer (chat); used by the chat group. */
  chatMaxOutputTokens: OutputTokens
})
export type TaskModel = typeof TaskModel.Type

export const EmbeddingSettings = Schema.Struct({
  connectionId: Schema.String,
  model: ModelId,
  batchSize: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 512 }))
})
export type EmbeddingSettings = typeof EmbeddingSettings.Type

/** Decision model through Ollama's System One API (required). */
export const DecisionSettings = Schema.Struct({
  /** Ollama server, without `/v1`. */
  baseUrl: Url,
  model: ModelId,
  contextTokens: Tokens
})
export type DecisionSettings = typeof DecisionSettings.Type

/** The settings without secrets: what is stored next to the sealed keys, and what the page edits. */
export const ModelSettingsBody = Schema.Struct({
  connections: Schema.Array(ModelConnection).check(Schema.isMaxLength(20)),
  /** Null: the group has no model (its tasks fail with "not configured"). */
  tasks: Schema.Struct({
    summaries: Schema.NullOr(TaskModel),
    cards: Schema.NullOr(TaskModel),
    chat: Schema.NullOr(TaskModel)
  }),
  /** Null: no index and no chat. */
  embedding: Schema.NullOr(EmbeddingSettings),
  decision: DecisionSettings
})
export type ModelSettingsBody = typeof ModelSettingsBody.Type

/** What the settings page shows. */
export class ModelSettingsView extends Schema.Class<ModelSettingsView>("ModelSettingsView")({
  ...ModelSettingsBody.fields,
  /** Connection ids with an API key. */
  connectionsWithKey: Schema.Array(Schema.String),
  /** `environment`: nothing saved yet, the values come from the AI_* / EMBEDDING_* / DECISION_* variables. */
  source: Schema.Literals(["environment", "saved"]),
  updatedAt: Schema.NullOr(Schema.Date),
  updatedBy: Schema.NullOr(Schema.String)
}) {}

/**
 * Saved from the page. `apiKeys` by connection id: a string sets the key, null removes it, a missing entry keeps
 * the stored one.
 */
export const ModelSettingsInput = Schema.Struct({
  ...ModelSettingsBody.fields,
  apiKeys: Schema.Record(Schema.String, Schema.NullOr(Schema.String.check(Schema.isMaxLength(4096))))
})
export type ModelSettingsInput = typeof ModelSettingsInput.Type

/** An account, for the administrators section. */
export class UserEntry extends Schema.Class<UserEntry>("UserEntry")({
  id: Schema.String,
  name: Schema.String,
  email: Schema.String,
  admin: Schema.Boolean,
  createdAt: Schema.Date
}) {}

/** Default base URL of each preset (the custom one has none). */
export const PRESET_BASE_URLS: Readonly<Record<ConnectionPreset, string>> = {
  openrouter: "https://openrouter.ai/api/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
  openai: "https://api.openai.com/v1",
  mistral: "https://api.mistral.ai/v1",
  groq: "https://api.groq.com/openai/v1",
  ollama: "http://localhost:11434/v1",
  vllm: "http://localhost:8000/v1",
  custom: ""
}
