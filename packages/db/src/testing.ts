/**
 * Test support: a fresh, migrated database for integration tests. Kept out of
 * the main entry point; refuses to touch databases not named `*_test`.
 */
import { sql } from "drizzle-orm"
import { Effect, Layer, Redacted } from "effect"
import { Database, query, runMigrations } from "./client.ts"
import { RepositoriesLive } from "./index.ts"

export const testDatabaseUrl = (): string | undefined => process.env["TEST_DATABASE_URL"]

const assertTestDatabase = (url: string) => {
  const name = new URL(url).pathname.replace(/^\//, "")
  if (!name.endsWith("_test")) {
    throw new Error(`Refusing to reset "${name}": test databases must be named *_test`)
  }
}

/** Drops everything and re-applies the migrations. */
export const resetDatabase = Database.use(({ db }) =>
  query("test.reset", () =>
    db.execute(sql`drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;`)
  )
).pipe(Effect.andThen(runMigrations()))

/** Repositories on a freshly reset test database. */
export const makeTestDatabaseLayer = (url: string) => {
  assertTestDatabase(url)
  const database = Layer.effect(Database, Database.make({ url: Redacted.make(url), maxConnections: 5 }))
  const reset = Layer.effectDiscard(resetDatabase)
  return RepositoriesLive.pipe(Layer.provideMerge(reset), Layer.provideMerge(database))
}
