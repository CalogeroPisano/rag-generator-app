/**
 * The models in use: resolved from the saved model settings (or the environment until they are saved), built by
 * the model adapters and cached until the settings change. Use cases do not see the settings: they run inside
 * `withLanguageModel(task)`, `withEmbeddingModel` or `withDecisionModel`, which provide the model of the moment.
 */
import { Context, Effect, Layer, Option, Ref } from "effect"
import type { DatabaseError } from "../domain/errors.ts"
import type { ModelConnection, ModelSettingsBody, ModelTask } from "../domain/settings.ts"
import {
  AiError,
  DecisionModel,
  DecisionModelFactory,
  type DecisionModelShape,
  EmbeddingModel,
  EmbeddingModelFactory,
  type EmbeddingModelShape,
  LanguageModel,
  LanguageModelFactory,
  type LanguageModelShape,
  type ResolvedConnection
} from "../ports/outbound/models.ts"
import { SettingsRepository, type StoredModelSettings } from "../ports/outbound/repositories.ts"
import { SecretBox } from "../ports/outbound/secret-box.ts"
import { AppConfig } from "./config.ts"

/** How often another process's save is looked for. */
const VERSION_CHECK_MS = 5_000

const TASK_LABELS: Readonly<Record<ModelTask, string>> = {
  summaries: "riassunti",
  cards: "schede",
  chat: "chat"
}

/** Context of a sealed API key: binds it to its connection. */
export const apiKeyContext = (connectionId: string) => `model-connection:${connectionId}`

/** Settings in use, with where they come from. */
export interface CurrentModelSettings {
  readonly body: ModelSettingsBody
  readonly stored: Option.Option<StoredModelSettings>
}

const notConfigured = (message: string) =>
  Effect.fail(new AiError({ kind: "not_configured", message, retryable: false }))

const unconfiguredLanguageModel = (task: ModelTask): LanguageModelShape => ({
  modelId: undefined,
  contextTokens: 8192,
  maxOutputTokens: 2048,
  chatMaxOutputTokens: 1024,
  generateObject: () =>
    notConfigured(`Nessun modello configurato per ${TASK_LABELS[task]}: impostalo nella pagina Impostazioni`),
  generateText: () =>
    notConfigured(`Nessun modello configurato per ${TASK_LABELS[task]}: impostalo nella pagina Impostazioni`)
})

const unconfiguredEmbeddingModel: EmbeddingModelShape = {
  modelId: undefined,
  embed: () => notConfigured("Modello di embedding non configurato: impostalo nella pagina Impostazioni")
}

interface Cache {
  /** Time of the save the cached models were built from (0: environment). */
  readonly version: number
  readonly checkedAt: number
  readonly settings: CurrentModelSettings | undefined
  readonly models: ReadonlyMap<string, unknown>
}

export class ModelRegistry extends Context.Service<
  ModelRegistry,
  {
    /** The settings in use (saved, or from the environment). */
    current(): Effect.Effect<CurrentModelSettings, DatabaseError>
    languageModel(task: ModelTask): Effect.Effect<LanguageModelShape, DatabaseError>
    embeddingModel(): Effect.Effect<EmbeddingModelShape, DatabaseError>
    decisionModel(): Effect.Effect<DecisionModelShape, DatabaseError>
    /** Forgets the cached models (after a save in this process). */
    invalidate(): Effect.Effect<void>
  }
>()("code-to-rag/core/ModelRegistry") {
  static readonly layer = Layer.effect(
    ModelRegistry,
    Effect.gen(function* () {
      const config = yield* AppConfig
      const repository = yield* SettingsRepository
      const secretBox = yield* SecretBox
      const languageFactory = yield* LanguageModelFactory
      const embeddingFactory = yield* EmbeddingModelFactory
      const decisionFactory = yield* DecisionModelFactory
      const defaults = config.models
      const cache = yield* Ref.make<Cache>({ version: -1, checkedAt: 0, settings: undefined, models: new Map() })

      // Rebuilds everything when another process saved new settings; checked at most every VERSION_CHECK_MS.
      const fresh = Effect.gen(function* () {
        const state = yield* Ref.get(cache)
        const now = Date.now()
        if (state.settings !== undefined && now - state.checkedAt < VERSION_CHECK_MS) return state
        const version = Option.match(yield* repository.modelSettingsVersion(), {
          onNone: () => 0,
          onSome: (date) => date.getTime()
        })
        if (state.settings !== undefined && version === state.version) {
          const next = { ...state, checkedAt: now }
          yield* Ref.set(cache, next)
          return next
        }
        const stored = yield* repository.loadModelSettings()
        const next: Cache = {
          version,
          checkedAt: now,
          settings: { body: Option.match(stored, { onNone: () => defaults.body, onSome: (s) => s.body }), stored },
          models: new Map()
        }
        yield* Ref.set(cache, next)
        return next
      })

      const cached = <A>(key: string, build: (settings: CurrentModelSettings) => Effect.Effect<A, DatabaseError>) =>
        Effect.gen(function* () {
          const state = yield* fresh
          const hit = state.models.get(key)
          if (hit !== undefined) return hit as A
          const model = yield* build(state.settings!)
          yield* Ref.update(cache, (current) =>
            current.version === state.version
              ? { ...current, models: new Map([...current.models, [key, model]]) }
              : current
          )
          return model
        })

      /** The connection with its API key opened (saved key, or the environment's one before any save). */
      const connection = (
        settings: CurrentModelSettings,
        connectionId: string
      ): Effect.Effect<ResolvedConnection | undefined, DatabaseError> =>
        Effect.gen(function* () {
          const found: ModelConnection | undefined = settings.body.connections.find((c) => c.id === connectionId)
          if (found === undefined) return undefined
          const apiKey = yield* Option.match(settings.stored, {
            onNone: () => Effect.succeed(defaults.apiKeys[found.id]),
            onSome: (stored) => {
              const sealed = stored.sealedKeys[found.id]
              return sealed === undefined
                ? Effect.succeed(undefined)
                : secretBox.decrypt(sealed, apiKeyContext(found.id)).pipe(
                    // A key sealed with another APP_ENCRYPTION_KEY: the connection works as if it had none.
                    Effect.catchTag("EncryptionError", () =>
                      Effect.logWarning(`API key of connection ${found.name} cannot be decrypted`).pipe(
                        Effect.as(undefined)
                      )
                    )
                  )
            }
          })
          return {
            name: found.name,
            baseUrl: found.baseUrl,
            apiKey,
            structuredOutputs: found.structuredOutputs,
            concurrency: found.concurrency
          } satisfies ResolvedConnection
        })

      return ModelRegistry.of({
        current: () => fresh.pipe(Effect.map((state) => state.settings!)),
        languageModel: (task) =>
          cached(`language:${task}`, (settings) =>
            Effect.gen(function* () {
              const chosen = settings.body.tasks[task]
              if (chosen === null) return unconfiguredLanguageModel(task)
              const resolved = yield* connection(settings, chosen.connectionId)
              if (resolved === undefined) return unconfiguredLanguageModel(task)
              return yield* languageFactory.make({
                connection: resolved,
                model: chosen.model,
                contextTokens: chosen.contextTokens,
                maxOutputTokens: chosen.maxOutputTokens,
                chatMaxOutputTokens: chosen.chatMaxOutputTokens,
                policy: defaults.policy
              })
            })
          ),
        embeddingModel: () =>
          cached("embedding", (settings) =>
            Effect.gen(function* () {
              const chosen = settings.body.embedding
              if (chosen === null) return unconfiguredEmbeddingModel
              const resolved = yield* connection(settings, chosen.connectionId)
              if (resolved === undefined) return unconfiguredEmbeddingModel
              return yield* embeddingFactory.make({
                connection: resolved,
                model: chosen.model,
                batchSize: chosen.batchSize,
                policy: defaults.policy
              })
            })
          ),
        decisionModel: () =>
          cached("decision", (settings) =>
            decisionFactory.make({
              baseUrl: settings.body.decision.baseUrl,
              model: settings.body.decision.model,
              contextTokens: settings.body.decision.contextTokens,
              maxQuestions: defaults.decision.maxQuestions,
              concurrency: defaults.decision.concurrency,
              keepAlive: defaults.decision.keepAlive,
              policy: defaults.decision
            })
          ),
        invalidate: () => Ref.update(cache, (state) => ({ ...state, checkedAt: 0, version: -1 }))
      })
    })
  )
}

/** Runs `effect` with the language model of a group of tasks. */
export const withLanguageModel =
  (task: ModelTask) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>
  ): Effect.Effect<A, E | DatabaseError, Exclude<R, LanguageModel> | ModelRegistry> =>
    Effect.flatMap(Effect.service(ModelRegistry), (registry) => registry.languageModel(task)).pipe(
      Effect.flatMap((model) => Effect.provideService(effect, LanguageModel, model))
    )

/** Runs `effect` with the embedding model in use. */
export const withEmbeddingModel = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E | DatabaseError, Exclude<R, EmbeddingModel> | ModelRegistry> =>
  Effect.flatMap(Effect.service(ModelRegistry), (registry) => registry.embeddingModel()).pipe(
    Effect.flatMap((model) => Effect.provideService(effect, EmbeddingModel, model))
  )

/** Runs `effect` with the decision model in use. */
export const withDecisionModel = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E | DatabaseError, Exclude<R, DecisionModel> | ModelRegistry> =>
  Effect.flatMap(Effect.service(ModelRegistry), (registry) => registry.decisionModel()).pipe(
    Effect.flatMap((model) => Effect.provideService(effect, DecisionModel, model))
  )
