import { DatabaseError } from "@code-to-rag/core/outbound"
import { Config, Context, Effect, Layer, Redacted } from "effect"
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"
import { migrate } from "drizzle-orm/node-postgres/migrator"
import { fileURLToPath } from "node:url"
import pg from "pg"
import * as schema from "./schema/index.ts"

export type Drizzle = NodePgDatabase<typeof schema>

/**
 * The Postgres pool and the Drizzle client on top of it. The pool is opened
 * when the layer is built and closed when the runtime is disposed. It is also
 * handed to Better Auth, so the web app uses one pool only.
 */
export class Database extends Context.Service<
  Database,
  {
    readonly db: Drizzle
    readonly pool: pg.Pool
  }
>()("code-to-rag/db/Database") {
  static readonly make = (options: { readonly url: Redacted.Redacted; readonly maxConnections: number }) =>
    Effect.gen(function* () {
      const pool = yield* Effect.acquireRelease(
        Effect.sync(() => new pg.Pool({ connectionString: Redacted.value(options.url), max: options.maxConnections })),
        (pool) => Effect.promise(() => pool.end())
      )
      // An idle client erroring (e.g. Postgres restarted) must not crash the process.
      pool.on("error", () => undefined)
      return Database.of({ db: drizzle({ client: pool, schema }), pool })
    })

  static readonly layer = Layer.effect(
    Database,
    Effect.gen(function* () {
      const url = yield* Config.Redacted("DATABASE_URL")
      const maxConnections = yield* Config.Int("DATABASE_POOL_MAX").pipe(Config.withDefault(10))
      return yield* Database.make({ url, maxConnections })
    })
  )
}

/** Wraps a Drizzle/pg promise, mapping any failure to `DatabaseError`. */
export const query = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new DatabaseError({ operation, cause }) })

export const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url))

/** Applies pending migrations (tracked in the `drizzle.__drizzle_migrations` table). */
export const runMigrations = (folder: string = migrationsFolder) =>
  Database.use(({ db }) => query("migrate", () => migrate(db, { migrationsFolder: folder })))
