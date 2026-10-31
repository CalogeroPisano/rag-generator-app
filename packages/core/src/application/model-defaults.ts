/**
 * Initial model settings, read from the environment (AI_*, EMBEDDING_*, DECISION_*): they apply until an
 * administrator saves the settings page, so that existing installations keep working unchanged.
 */
import { Config, Duration, Effect, Option, Redacted } from "effect"
import type { ConnectionPreset, ModelConnection, ModelSettingsBody, TaskModel } from "../domain/settings.ts"
import type { CallPolicy } from "../ports/outbound/models.ts"

/** Ids of the connections built from the environment. */
export const ENV_CHAT_CONNECTION = "00000000-0000-4000-8000-000000000001"
export const ENV_EMBEDDING_CONNECTION = "00000000-0000-4000-8000-000000000002"

export interface DecisionPolicy extends CallPolicy {
  readonly concurrency: number
  readonly keepAlive: string
  readonly maxQuestions: number
}

export interface ModelDefaults {
  readonly body: ModelSettingsBody
  /** API keys of the environment connections. */
  readonly apiKeys: Readonly<Record<string, Redacted.Redacted>>
  /** Limits of the language and embedding model calls. */
  readonly policy: CallPolicy
  readonly decision: DecisionPolicy
}

/** An optional setting: unset and empty (`AI_MODEL=` in a .env file) both mean "not configured". */
const optionalString = (name: string) =>
  Config.option(Config.String(name)).pipe(
    Config.map((value) =>
      Option.getOrUndefined(
        Option.filter(
          Option.map(value, (text) => text.trim()),
          (text) => text !== ""
        )
      )
    )
  )

const presetOf = (baseUrl: string): ConnectionPreset => (/:11434(\/|$)/.test(baseUrl) ? "ollama" : "custom")

export const readModelDefaults = Effect.gen(function* () {
  const baseUrl = (yield* Config.String("AI_BASE_URL").pipe(Config.withDefault("http://localhost:11434/v1"))).trim()
  const apiKey = yield* optionalString("AI_API_KEY")
  const model = yield* optionalString("AI_MODEL")
  const concurrency = Math.max(1, yield* Config.Int("AI_CONCURRENCY").pipe(Config.withDefault(2)))
  const chat: ModelConnection = {
    id: ENV_CHAT_CONNECTION,
    name: yield* Config.String("AI_PROVIDER_NAME").pipe(Config.withDefault("openai-compatible")),
    preset: presetOf(baseUrl),
    baseUrl,
    structuredOutputs: yield* Config.Boolean("AI_STRUCTURED_OUTPUTS").pipe(Config.withDefault(true)),
    concurrency
  }
  const task: TaskModel | null =
    model === undefined
      ? null
      : {
          connectionId: chat.id,
          model,
          contextTokens: yield* Config.Int("AI_CONTEXT_TOKENS").pipe(Config.withDefault(16_384)),
          maxOutputTokens: yield* Config.Int("AI_MAX_OUTPUT_TOKENS").pipe(Config.withDefault(4096)),
          chatMaxOutputTokens: yield* Config.Int("AI_CHAT_MAX_OUTPUT_TOKENS").pipe(Config.withDefault(1024))
        }

  // The embedding endpoint defaults to the chat one (same Ollama or vLLM server).
  const embeddingModel = yield* optionalString("EMBEDDING_MODEL")
  const embeddingUrl = yield* optionalString("EMBEDDING_BASE_URL")
  const embeddingKey = yield* optionalString("EMBEDDING_API_KEY")
  const separate = embeddingUrl !== undefined || embeddingKey !== undefined
  const embeddingConnection: ModelConnection | undefined =
    embeddingModel !== undefined && separate
      ? {
          ...chat,
          id: ENV_EMBEDDING_CONNECTION,
          name: `${chat.name} (embedding)`,
          baseUrl: embeddingUrl ?? baseUrl,
          preset: presetOf(embeddingUrl ?? baseUrl)
        }
      : undefined

  const apiKeys: Record<string, Redacted.Redacted> = {}
  if (apiKey !== undefined) apiKeys[chat.id] = Redacted.make(apiKey)
  if (embeddingConnection !== undefined && (embeddingKey ?? apiKey) !== undefined) {
    apiKeys[embeddingConnection.id] = Redacted.make((embeddingKey ?? apiKey)!)
  }

  const body: ModelSettingsBody = {
    connections: embeddingConnection === undefined ? [chat] : [chat, embeddingConnection],
    tasks: { summaries: task, cards: task, chat: task },
    embedding:
      embeddingModel === undefined
        ? null
        : {
            connectionId: (embeddingConnection ?? chat).id,
            model: embeddingModel,
            batchSize: yield* Config.Int("EMBEDDING_BATCH_SIZE").pipe(Config.withDefault(16))
          },
    decision: {
      baseUrl: (yield* Config.String("DECISION_BASE_URL").pipe(Config.withDefault("http://localhost:11434")))
        .trim()
        .replace(/\/+$/, ""),
      model: (yield* Config.String("DECISION_MODEL").pipe(Config.withDefault("d1-omni"))).trim(),
      contextTokens: yield* Config.Int("DECISION_CONTEXT_TOKENS").pipe(Config.withDefault(12_000))
    }
  }
  return {
    body,
    apiKeys,
    policy: {
      timeout: yield* Config.Duration("AI_TIMEOUT").pipe(Config.withDefault(Duration.minutes(5))),
      maxRetries: yield* Config.Int("AI_MAX_RETRIES").pipe(Config.withDefault(2)),
      temperature: yield* Config.Number("AI_TEMPERATURE").pipe(Config.withDefault(0.1))
    },
    decision: {
      timeout: yield* Config.Duration("DECISION_TIMEOUT").pipe(Config.withDefault(Duration.minutes(2))),
      maxRetries: yield* Config.Int("DECISION_MAX_RETRIES").pipe(Config.withDefault(2)),
      temperature: 0,
      concurrency: Math.max(1, yield* Config.Int("DECISION_CONCURRENCY").pipe(Config.withDefault(1))),
      keepAlive: yield* Config.String("DECISION_KEEP_ALIVE").pipe(Config.withDefault("10m")),
      maxQuestions: Math.min(64, Math.max(2, yield* Config.Int("DECISION_MAX_QUESTIONS").pipe(Config.withDefault(64))))
    }
  } satisfies ModelDefaults
})
