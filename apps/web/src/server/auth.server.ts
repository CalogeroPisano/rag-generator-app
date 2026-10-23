import { Database, schema } from "@code-to-rag/db"
import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { APIError } from "better-auth/api"
import { tanstackStartCookies } from "better-auth/tanstack-start"
import { count } from "drizzle-orm"
import { Effect } from "effect"
import { runtime } from "./runtime.server.ts"

/**
 * Sign-up policy: the very first account can always be created (bootstrap of
 * a fresh installation); after that, only when `AUTH_ALLOW_SIGNUP=true`.
 */
const allowSignupAfterBootstrap = process.env["AUTH_ALLOW_SIGNUP"] === "true"

const makeAuth = async () => {
  const { db } = await runtime.runPromise(Effect.service(Database))

  const countUsers = async () => {
    const [row] = await db.select({ value: count() }).from(schema.user)
    return row?.value ?? 0
  }

  const auth = betterAuth({
    appName: "Code-to-RAG",
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification
      }
    }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (!allowSignupAfterBootstrap && (await countUsers()) > 0) {
              throw new APIError("FORBIDDEN", { message: "La registrazione è disabilitata" })
            }
            return { data: user }
          }
        }
      }
    },
    // On-premise product: never send usage data anywhere.
    telemetry: { enabled: false },
    // Must stay the last plugin.
    plugins: [tanstackStartCookies()]
  })
  return Object.assign(auth, { countUsers })
}

type Auth = Awaited<ReturnType<typeof makeAuth>>

const globalAuth = globalThis as typeof globalThis & { __codeToRagAuth?: Promise<Auth> }

/** Better Auth instance sharing the application's Postgres pool. */
export const getAuth = (): Promise<Auth> => (globalAuth.__codeToRagAuth ??= makeAuth())

export const isSignupOpen = async (): Promise<boolean> => {
  const auth = await getAuth()
  return allowSignupAfterBootstrap || (await auth.countUsers()) === 0
}
