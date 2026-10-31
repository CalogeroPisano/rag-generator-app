import { ModelSettingsInput, ModelSettingsView, Settings, UserEntry } from "@code-to-rag/core"
import { createServerFn } from "@tanstack/react-start"
import { Effect, Schema } from "effect"
import { authMiddleware } from "@/server/middleware"
import { runEffect } from "@/server/run.server"

const encodeSettings = Schema.encodeSync(ModelSettingsView)
const encodeUsers = Schema.encodeSync(Schema.Array(UserEntry))

const validate = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
  Schema.toStandardSchemaV1(schema)

const actor = (user: { readonly id: string; readonly name: string }) => ({ id: user.id, name: user.name })

/** Model settings (without API keys) and accounts: administrators only (checked by core). */
export const getSettings = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(({ context }) =>
    runEffect(
      Effect.all({
        settings: Settings.getModelSettings(actor(context.user)).pipe(Effect.map(encodeSettings)),
        users: Settings.listUsers(actor(context.user)).pipe(Effect.map(encodeUsers))
      })
    )
  )

export const saveModelSettings = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(validate(ModelSettingsInput))
  .handler(({ data, context }) =>
    runEffect(Settings.saveModelSettings(actor(context.user), data).pipe(Effect.map(encodeSettings)))
  )

export const changeAdmin = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(validate(Schema.Struct({ userId: Schema.String.check(Schema.isMaxLength(255)), admin: Schema.Boolean })))
  .handler(({ data, context }) =>
    runEffect(Settings.setAdmin(actor(context.user), data.userId, data.admin).pipe(Effect.map(encodeUsers)))
  )
