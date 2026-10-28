import { APICallError } from "ai"
import { MockEmbeddingModelV4 } from "ai/test"
import { Duration, Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import type { AiConfigShape } from "../src/config.ts"
import { EmbeddingModel, makeEmbeddingModel } from "../src/embedding-model.ts"
import { type ModelCall, ModelCallRecorder } from "../src/model-call.ts"
import { citedSources } from "../src/prompts/chat.ts"
import { hashEmbedding } from "../src/testing.ts"

const config: AiConfigShape = {
  baseUrl: "http://localhost:11434/v1",
  providerName: "test",
  model: "test-model",
  apiKey: undefined,
  structuredOutputs: true,
  timeout: Duration.seconds(5),
  maxRetries: 2,
  concurrency: 1,
  contextTokens: 8192,
  maxOutputTokens: 1024,
  chatMaxOutputTokens: 512,
  temperature: 0,
  embedding: { baseUrl: "http://localhost:11434/v1", model: "test-embedding", apiKey: undefined, batchSize: 2 }
}

const run = async (model: MockEmbeddingModelV4, texts: ReadonlyArray<string>) => {
  const calls: Array<ModelCall> = []
  const recorder = Layer.succeed(
    ModelCallRecorder,
    ModelCallRecorder.of({ record: (call) => Effect.sync(() => void calls.push(call)) })
  )
  const layer = Layer.effect(
    EmbeddingModel,
    makeEmbeddingModel({ model, modelId: "test-embedding", config, retryBaseDelay: "1 millis" })
  ).pipe(Layer.provide(recorder))
  const result = await Effect.runPromise(
    EmbeddingModel.use((service) =>
      service.embed({ format: { id: "card-chunk", version: 1 }, context: { phase: "index" }, texts })
    ).pipe(Effect.result, Effect.provide(layer))
  )
  return { result, calls }
}

describe("EmbeddingModel", () => {
  it("embeds in batches, keeps the order and records every request", async () => {
    const model = new MockEmbeddingModelV4({
      maxEmbeddingsPerCall: 10,
      doEmbed: ({ values }) =>
        Promise.resolve({
          embeddings: values.map((value) => [value.length, 1]),
          usage: { tokens: values.length },
          warnings: []
        })
    })
    const { result, calls } = await run(model, ["a", "bb", "ccc"])
    expect(result).toMatchObject({
      _tag: "Success",
      success: [
        [1, 1],
        [2, 1],
        [3, 1]
      ]
    })
    expect(calls.map((call) => [call.task, call.promptVersion, call.outcome, call.inputTokens])).toEqual([
      ["card-chunk", 1, "success", 2],
      ["card-chunk", 1, "success", 1]
    ])
  })

  it("retries transient errors", async () => {
    let attempt = 0
    const model = new MockEmbeddingModelV4({
      doEmbed: ({ values }) => {
        attempt++
        if (attempt === 1) {
          return Promise.reject(
            new APICallError({
              message: "busy",
              url: "http://localhost/v1/embeddings",
              requestBodyValues: {},
              statusCode: 503,
              isRetryable: true
            })
          )
        }
        return Promise.resolve({ embeddings: values.map(() => [1, 0]), usage: { tokens: 1 }, warnings: [] })
      }
    })
    const { result, calls } = await run(model, ["question"])
    expect(result._tag).toBe("Success")
    expect(calls.map((call) => [call.outcome, call.error])).toEqual([
      ["error", "AI_APICallError 503"],
      ["success", null]
    ])
  })
})

describe("citedSources", () => {
  it("returns the valid source numbers in order of first citation", () => {
    expect(citedSources("Yes [2]. Also [1][2] and [3, 1]. Not [9] or [0].", 3)).toEqual([2, 1, 3])
    expect(citedSources("No sources.", 3)).toEqual([])
  })
})

describe("hashEmbedding", () => {
  it("is normalized and closer for texts sharing words", () => {
    const dot = (a: ReadonlyArray<number>, b: ReadonlyArray<number>) => a.reduce((sum, x, i) => sum + x * b[i]!, 0)
    const upload = hashEmbedding("upload size limit")
    expect(dot(upload, upload)).toBeCloseTo(1)
    expect(dot(upload, hashEmbedding("maximum upload size"))).toBeGreaterThan(
      dot(upload, hashEmbedding("password reset email"))
    )
  })
})
