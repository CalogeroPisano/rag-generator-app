import {
  DatabaseError,
  ModelSettingsBody,
  NotFoundError,
  SettingsRepository,
  UserEntry,
  UserRepository
} from "@code-to-rag/core/outbound"
import { asc, count, eq } from "drizzle-orm"
import { Effect, Layer, Option, Schema } from "effect"
import { Database, query } from "./client.ts"
import { appAdmin, modelSettings } from "./schema/app.ts"
import { user } from "./schema/auth.ts"

const decodeBody = Schema.decodeUnknownEffect(ModelSettingsBody)
const decodeUsers = Schema.decodeUnknownEffect(Schema.Array(UserEntry))

export const SettingsRepositoryLive = Layer.effect(
  SettingsRepository,
  Effect.gen(function* () {
    const { db } = yield* Database
    return SettingsRepository.of({
      loadModelSettings: Effect.fnUntraced(function* () {
        const rows = yield* query("settings.load", () => db.select().from(modelSettings).where(eq(modelSettings.id, 1)))
        const row = rows[0]
        if (row === undefined) return Option.none()
        // Rows leave the database validated, like every other row.
        const body = yield* decodeBody(row.body).pipe(
          Effect.mapError((cause) => new DatabaseError({ operation: "settings.decode", cause }))
        )
        return Option.some({ body, sealedKeys: row.sealedKeys, updatedAt: row.updatedAt, updatedBy: row.updatedBy })
      }),
      modelSettingsVersion: () =>
        query("settings.version", () =>
          db.select({ updatedAt: modelSettings.updatedAt }).from(modelSettings).where(eq(modelSettings.id, 1))
        ).pipe(Effect.map((rows) => Option.fromNullishOr(rows[0]?.updatedAt))),
      saveModelSettings: (settings) => {
        const values = {
          body: settings.body,
          sealedKeys: { ...settings.sealedKeys },
          updatedAt: settings.updatedAt,
          updatedBy: settings.updatedBy
        }
        return query("settings.save", () =>
          db
            .insert(modelSettings)
            .values({ id: 1, ...values })
            .onConflictDoUpdate({ target: modelSettings.id, set: values })
        ).pipe(Effect.asVoid)
      }
    })
  })
)

export const UserRepositoryLive = Layer.effect(
  UserRepository,
  Effect.gen(function* () {
    const { db } = yield* Database
    const admins = query("users.admins", () => db.select({ userId: appAdmin.userId }).from(appAdmin)).pipe(
      Effect.map((rows) => new Set(rows.map((row) => row.userId)))
    )
    const oldest = query("users.oldest", () =>
      db.select({ id: user.id }).from(user).orderBy(asc(user.createdAt), asc(user.id)).limit(1)
    ).pipe(Effect.map((rows) => rows[0]?.id))

    return UserRepository.of({
      list: Effect.fnUntraced(function* () {
        const [rows, granted, first] = yield* Effect.all([
          query("users.list", () =>
            db
              .select({ id: user.id, name: user.name, email: user.email, createdAt: user.createdAt })
              .from(user)
              .orderBy(asc(user.createdAt), asc(user.id))
          ),
          admins,
          oldest
        ])
        return yield* decodeUsers(
          rows.map((row) => ({ ...row, admin: granted.size === 0 ? row.id === first : granted.has(row.id) }))
        ).pipe(Effect.mapError((cause) => new DatabaseError({ operation: "users.decode", cause })))
      }),
      isAdmin: Effect.fnUntraced(function* (userId) {
        const granted = yield* admins
        return granted.size === 0 ? (yield* oldest) === userId : granted.has(userId)
      }),
      setAdmin: Effect.fnUntraced(function* (userId, admin, grantedBy) {
        const found = yield* query("users.exists", () =>
          db.select({ total: count() }).from(user).where(eq(user.id, userId))
        )
        if ((found[0]?.total ?? 0) === 0) return yield* new NotFoundError({ entity: "user", id: userId })
        yield* query("users.setAdmin", () =>
          db.transaction(async (tx) => {
            // The implicit administrator (oldest account, none granted) becomes an explicit one first.
            const [granted] = await tx.select({ total: count() }).from(appAdmin)
            if ((granted?.total ?? 0) === 0) {
              const [first] = await tx
                .select({ id: user.id })
                .from(user)
                .orderBy(asc(user.createdAt), asc(user.id))
                .limit(1)
              if (first !== undefined) await tx.insert(appAdmin).values({ userId: first.id, grantedBy })
            }
            if (admin) await tx.insert(appAdmin).values({ userId, grantedBy }).onConflictDoNothing()
            else await tx.delete(appAdmin).where(eq(appAdmin.userId, userId))
          })
        )
      })
    })
  })
)
