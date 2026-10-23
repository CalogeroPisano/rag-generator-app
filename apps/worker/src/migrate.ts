import { Database, migrationsFolder, runMigrations } from "@code-to-rag/db"
import { Config, Effect } from "effect"

/** Applies pending database migrations, then exits. Used by `pnpm db:migrate` and the `migrate` container. */
const program = Effect.gen(function* () {
  const folder = yield* Config.String("MIGRATIONS_DIR").pipe(Config.withDefault(migrationsFolder))
  yield* runMigrations(folder)
  yield* Effect.logInfo("Migrations applied")
}).pipe(Effect.provide(Database.layer))

Effect.runPromise(program).catch((error: unknown) => {
  console.error("Migration failed", error)
  process.exitCode = 1
})
