import { ConfigProvider, Effect, Layer, Redacted } from "effect"
import { describe, expect, it } from "vitest"
import { AiConfig } from "../src/config.ts"

const load = (env: Record<string, string>) =>
  Effect.runPromise(
    AiConfig.use(Effect.succeed).pipe(
      Effect.provide(AiConfig.layer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })))))
    )
  )

describe("AiConfig", () => {
  it("treats empty variables as not configured", async () => {
    const config = await load({ AI_MODEL: "", AI_API_KEY: "  " })
    expect(config.model).toBeUndefined()
    expect(config.apiKey).toBeUndefined()
    expect(config.contextTokens).toBe(16_384)
  })

  it("reads the model and keeps the key redacted", async () => {
    const config = await load({ AI_MODEL: "qwen3:4b", AI_API_KEY: "sk-test", AI_CONTEXT_TOKENS: "8192" })
    expect(config.model).toBe("qwen3:4b")
    expect(config.apiKey === undefined ? undefined : Redacted.value(config.apiKey)).toBe("sk-test")
    expect(JSON.stringify(config)).not.toContain("sk-test")
    expect(config.contextTokens).toBe(8192)
  })

  it("defaults the embedding endpoint and key to the chat ones", async () => {
    const config = await load({ AI_BASE_URL: "http://vllm:8000/v1", AI_API_KEY: "sk-chat", EMBEDDING_MODEL: "bge-m3" })
    expect(config.embedding.baseUrl).toBe("http://vllm:8000/v1")
    expect(config.embedding.model).toBe("bge-m3")
    expect(Redacted.value(config.embedding.apiKey!)).toBe("sk-chat")
    expect((await load({})).embedding.model).toBeUndefined()
  })
})
