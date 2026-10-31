import { AppConfig, ModelRegistry, Settings } from "@code-to-rag/core"
import {
  DecisionModelFactory,
  EmbeddingModelFactory,
  type LanguageModelConfig,
  LanguageModelFactory
} from "@code-to-rag/core/outbound"
import { Database, SecretBoxLive } from "@code-to-rag/postgres"
import { makeTestDatabaseLayer, resetDatabase, testDatabaseUrl } from "@code-to-rag/postgres/testing"
import { sql } from "drizzle-orm"
import { Effect, Layer, ManagedRuntime, Redacted } from "effect"
import { randomBytes, randomUUID } from "node:crypto"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

const url = testDatabaseUrl()
if (url === undefined && process.env["CI"] !== undefined) throw new Error("TEST_DATABASE_URL is required in CI")

/** Configurations the registry asked the (fake) adapters to build. */
const built: Array<LanguageModelConfig> = []

const factories = Layer.mergeAll(
  Layer.succeed(
    LanguageModelFactory,
    LanguageModelFactory.of({
      make: (config) =>
        Effect.sync(() => {
          built.push(config)
          return {
            modelId: config.model,
            contextTokens: config.contextTokens,
            maxOutputTokens: config.maxOutputTokens,
            chatMaxOutputTokens: config.chatMaxOutputTokens,
            generateObject: () => Effect.die(new Error("not used")),
            generateText: () => Effect.die(new Error("not used"))
          }
        })
    })
  ),
  Layer.succeed(
    EmbeddingModelFactory,
    EmbeddingModelFactory.of({
      make: (config) => Effect.succeed({ modelId: config.model, embed: () => Effect.die(new Error("not used")) })
    })
  ),
  Layer.succeed(
    DecisionModelFactory,
    DecisionModelFactory.of({
      make: (config) =>
        Effect.succeed({
          modelId: config.model,
          contextTokens: config.contextTokens,
          maxQuestions: config.maxQuestions,
          decide: () => Effect.die(new Error("not used"))
        })
    })
  )
)

const makeLayer = (databaseUrl: string) =>
  ModelRegistry.layer.pipe(
    Layer.provideMerge(factories),
    Layer.provideMerge(SecretBoxLive),
    Layer.provideMerge(AppConfig.layer),
    Layer.provideMerge(makeTestDatabaseLayer(databaseUrl))
  )
type Services = Layer.Success<ReturnType<typeof makeLayer>>

// Built at runtime: push protection rejects key-like literals.
const apiKey = ["sk", "or", "v1", randomBytes(8).toString("hex")].join("-")

describe.skipIf(url === undefined)("settings (PostgreSQL)", () => {
  let runtime: ManagedRuntime.ManagedRuntime<Services, unknown>
  const run = <A, E>(effect: Effect.Effect<A, E, Services>) => runtime.runPromise(effect)
  const flip = <A, E>(effect: Effect.Effect<A, E, Services>) => run(Effect.flip(effect))

  const first = { id: "user-first", name: "Prima" }
  const second = { id: "user-second", name: "Seconda" }

  beforeAll(async () => {
    process.env["APP_ENCRYPTION_KEY"] = randomBytes(32).toString("base64")
    process.env["AI_MODEL"] = "env-model"
    runtime = ManagedRuntime.make(makeLayer(url!))
    await run(Effect.void)
  })
  afterAll(async () => {
    delete process.env["AI_MODEL"]
    await runtime.dispose()
  })
  beforeEach(async () => {
    built.length = 0
    await run(resetDatabase)
    await run(ModelRegistry.use((registry) => registry.invalidate()))
    for (const [index, user] of [first, second].entries()) {
      await run(
        Database.use(({ db }) =>
          Effect.promise(() =>
            db.execute(
              sql`insert into "user" (id, name, email, email_verified, created_at, updated_at)
                  values (${user.id}, ${user.name}, ${`${user.id}@example.com`}, true, now() + ${`${index} seconds`}::interval, now())`
            )
          )
        )
      )
    }
  })

  it("lets the oldest account administer until administrators are granted, and keeps one", async () => {
    expect(await run(Settings.isAdmin(first.id))).toBe(true)
    expect((await flip(Settings.getModelSettings(second)))._tag).toBe("ForbiddenError")

    const users = await run(Settings.setAdmin(first, second.id, true))
    expect(users.map((u) => [u.id, u.admin])).toEqual([
      [first.id, true],
      [second.id, true]
    ])
    await run(Settings.setAdmin(second, first.id, false))
    expect(await run(Settings.isAdmin(first.id))).toBe(false)
    // The last administrator cannot be revoked.
    expect((await flip(Settings.setAdmin(second, second.id, false)))._tag).toBe("InvalidInputError")
  })

  it("saves connections and models, seals the API keys and switches the models in use", async () => {
    const initial = await run(Settings.getModelSettings(first))
    expect(initial).toMatchObject({ source: "environment", tasks: { cards: { model: "env-model" } } })

    const openrouter = randomUUID()
    const body = {
      connections: [
        ...initial.connections,
        {
          id: openrouter,
          name: "OpenRouter",
          preset: "openrouter" as const,
          baseUrl: "https://openrouter.ai/api/v1",
          structuredOutputs: true,
          concurrency: 4
        }
      ],
      tasks: {
        ...initial.tasks,
        cards: {
          connectionId: openrouter,
          model: "anthropic/claude-sonnet",
          contextTokens: 200_000,
          maxOutputTokens: 8192,
          chatMaxOutputTokens: 1024
        }
      },
      embedding: initial.embedding,
      decision: initial.decision
    }
    const saved = await run(Settings.saveModelSettings(first, { ...body, apiKeys: { [openrouter]: apiKey } }))
    expect(saved).toMatchObject({ source: "saved", updatedBy: "Prima", connectionsWithKey: [openrouter] })

    // Stored sealed: the key is nowhere in the database in clear.
    const rows = await run(
      Database.use(({ db }) =>
        Effect.promise(() => db.execute(sql`select row_to_json(m)::text as row from model_settings m`))
      )
    )
    expect(JSON.stringify(rows.rows)).not.toContain(apiKey)

    // The registry builds the saved models, with the key opened only for the adapter.
    const cards = await run(ModelRegistry.use((registry) => registry.languageModel("cards")))
    expect(cards.modelId).toBe("anthropic/claude-sonnet")
    const config = built.find((c) => c.model === "anthropic/claude-sonnet")!
    expect(config.connection).toMatchObject({
      name: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      concurrency: 4
    })
    expect(Redacted.value(config.connection.apiKey!)).toBe(apiKey)
    expect((await run(ModelRegistry.use((registry) => registry.languageModel("summaries")))).modelId).toBe("env-model")

    // No entry keeps the key, null removes it.
    expect((await run(Settings.saveModelSettings(first, { ...body, apiKeys: {} }))).connectionsWithKey).toEqual([
      openrouter
    ])
    expect(
      (await run(Settings.saveModelSettings(first, { ...body, apiKeys: { [openrouter]: null } }))).connectionsWithKey
    ).toEqual([])

    // A model pointing at a connection that does not exist is refused.
    const broken = { ...body, tasks: { ...body.tasks, chat: { ...body.tasks.cards, connectionId: randomUUID() } } }
    expect((await flip(Settings.saveModelSettings(first, { ...broken, apiKeys: {} })))._tag).toBe("InvalidInputError")
  })
})
