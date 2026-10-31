/**
 * Settings page: model settings and administrators. Only administrators read or change them; API keys are sealed
 * before they are stored and never returned.
 */
import { Effect, Option, Redacted } from "effect"
import { ForbiddenError, InvalidInputError } from "../domain/errors.ts"
import { type ModelSettingsInput, ModelSettingsView } from "../domain/settings.ts"
import { type Reviewer, SettingsRepository, UserRepository } from "../ports/outbound/repositories.ts"
import { SecretBox } from "../ports/outbound/secret-box.ts"
import { AppConfig } from "./config.ts"
import { apiKeyContext, ModelRegistry } from "./models.ts"

/** Whether the user is an administrator (the pages show the settings link only to them). */
export const isAdmin = Effect.fn("isAdmin")(function* (userId: string) {
  return yield* (yield* UserRepository).isAdmin(userId)
})

const ensureAdmin = Effect.fnUntraced(function* (actor: Reviewer) {
  if (!(yield* (yield* UserRepository).isAdmin(actor.id))) {
    return yield* new ForbiddenError({ message: "Solo gli amministratori possono gestire le impostazioni" })
  }
})

/** The model settings in use, without API keys. */
export const getModelSettings = Effect.fn("getModelSettings")(function* (actor: Reviewer) {
  yield* ensureAdmin(actor)
  const config = yield* AppConfig
  const current = yield* (yield* ModelRegistry).current()
  return Option.match(current.stored, {
    onNone: () =>
      new ModelSettingsView({
        ...current.body,
        connectionsWithKey: Object.keys(config.models.apiKeys),
        source: "environment",
        updatedAt: null,
        updatedBy: null
      }),
    onSome: (stored) =>
      new ModelSettingsView({
        ...stored.body,
        connectionsWithKey: Object.keys(stored.sealedKeys),
        source: "saved",
        updatedAt: stored.updatedAt,
        updatedBy: stored.updatedBy
      })
  })
})

/**
 * Saves the model settings. An API key in the input replaces the stored one (null removes it); a connection without
 * an entry keeps its key, including one that came from the environment. Every process picks the new models within
 * a few seconds; running phases finish with the models they started with.
 */
export const saveModelSettings = Effect.fn("saveModelSettings")(function* (actor: Reviewer, input: ModelSettingsInput) {
  yield* ensureAdmin(actor)
  const config = yield* AppConfig
  const repository = yield* SettingsRepository
  const secretBox = yield* SecretBox
  const registry = yield* ModelRegistry

  const ids = new Set(input.connections.map((connection) => connection.id))
  if (ids.size !== input.connections.length) {
    return yield* new InvalidInputError({ message: "Due connessioni hanno lo stesso identificativo" })
  }
  const used = [...Object.values(input.tasks), input.embedding].flatMap((choice) =>
    choice === null ? [] : [choice.connectionId]
  )
  if (used.some((id) => !ids.has(id))) {
    return yield* new InvalidInputError({ message: "Un modello usa una connessione che non esiste" })
  }

  const current = yield* registry.current()
  const sealedKeys: Record<string, string> = {}
  for (const connection of input.connections) {
    const key = input.apiKeys[connection.id]
    if (key === null) continue
    if (key !== undefined && key.trim() !== "") {
      sealedKeys[connection.id] = yield* secretBox.encrypt(Redacted.make(key.trim()), apiKeyContext(connection.id))
      continue
    }
    // No new key: keep the stored one, or seal the environment's one on the first save.
    const kept = Option.match(current.stored, {
      onNone: () => undefined,
      onSome: (stored) => stored.sealedKeys[connection.id]
    })
    if (kept !== undefined) sealedKeys[connection.id] = kept
    else if (Option.isNone(current.stored) && config.models.apiKeys[connection.id] !== undefined) {
      sealedKeys[connection.id] = yield* secretBox.encrypt(
        config.models.apiKeys[connection.id]!,
        apiKeyContext(connection.id)
      )
    }
  }
  const { apiKeys: _apiKeys, ...body } = input
  yield* repository.saveModelSettings({ body, sealedKeys, updatedAt: new Date(), updatedBy: actor.name })
  yield* registry.invalidate()
  yield* Effect.logInfo("Model settings saved").pipe(Effect.annotateLogs({ by: actor.name }))
  return yield* getModelSettings(actor)
})

/** Every account with its administrator flag. */
export const listUsers = Effect.fn("listUsers")(function* (actor: Reviewer) {
  yield* ensureAdmin(actor)
  return yield* (yield* UserRepository).list()
})

/** Grants or revokes the administrator role; the last administrator cannot be revoked. */
export const setAdmin = Effect.fn("setAdmin")(function* (actor: Reviewer, userId: string, admin: boolean) {
  yield* ensureAdmin(actor)
  const users = yield* UserRepository
  const all = yield* users.list()
  if (!admin && all.filter((entry) => entry.admin && entry.id !== userId).length === 0) {
    return yield* new InvalidInputError({ message: "Serve almeno un amministratore" })
  }
  yield* users.setAdmin(userId, admin, actor.name)
  return yield* users.list()
})
