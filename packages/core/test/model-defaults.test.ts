import { ConfigProvider, Effect, Redacted } from "effect"
import { describe, expect, it } from "vitest"
import { ENV_CHAT_CONNECTION, ENV_EMBEDDING_CONNECTION, readModelDefaults } from "../src/application/model-defaults.ts"

const load = (env: Record<string, string>) =>
  Effect.runPromise(readModelDefaults.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })))))

// Built at runtime: push protection rejects key-like literals.
const key = (name: string) => ["sk", name, "0123456789"].join("-")

describe("readModelDefaults", () => {
  it("treats empty variables as not configured", async () => {
    const defaults = await load({ AI_MODEL: "", AI_API_KEY: "  " })
    expect(defaults.body.tasks).toEqual({ summaries: null, cards: null, chat: null })
    expect(defaults.apiKeys).toEqual({})
    expect(defaults.body.embedding).toBeNull()
    expect(defaults.body.decision).toEqual({
      baseUrl: "http://localhost:11434",
      model: "d1-omni",
      contextTokens: 12_000
    })
  })

  it("uses the same model for every group and keeps the key redacted", async () => {
    const defaults = await load({ AI_MODEL: "qwen3:4b", AI_API_KEY: key("chat"), AI_CONTEXT_TOKENS: "8192" })
    expect(defaults.body.connections).toMatchObject([
      { id: ENV_CHAT_CONNECTION, preset: "ollama", baseUrl: "http://localhost:11434/v1" }
    ])
    expect(defaults.body.tasks.summaries).toEqual(defaults.body.tasks.chat)
    expect(defaults.body.tasks.cards).toMatchObject({
      model: "qwen3:4b",
      contextTokens: 8192,
      connectionId: ENV_CHAT_CONNECTION
    })
    expect(Redacted.value(defaults.apiKeys[ENV_CHAT_CONNECTION]!)).toBe(key("chat"))
    expect(JSON.stringify(defaults)).not.toContain(key("chat"))
  })

  it("gives the embeddings their own connection when their endpoint or key differs", async () => {
    const same = await load({ AI_BASE_URL: "http://vllm:8000/v1", EMBEDDING_MODEL: "bge-m3" })
    expect(same.body.embedding).toMatchObject({ connectionId: ENV_CHAT_CONNECTION, model: "bge-m3" })
    const separate = await load({
      AI_API_KEY: key("chat"),
      EMBEDDING_MODEL: "bge-m3",
      EMBEDDING_BASE_URL: "http://tei:80/v1"
    })
    expect(separate.body.embedding?.connectionId).toBe(ENV_EMBEDDING_CONNECTION)
    expect(separate.body.connections[1]).toMatchObject({ baseUrl: "http://tei:80/v1", preset: "custom" })
    // The embedding key defaults to the chat one.
    expect(Redacted.value(separate.apiKeys[ENV_EMBEDDING_CONNECTION]!)).toBe(key("chat"))
  })
})
