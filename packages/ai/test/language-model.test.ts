import { APICallError } from "ai"
import { simulateReadableStream } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import { Duration, Effect, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import type { AiConfigShape } from "../src/config.ts"
import { LanguageModel, makeLanguageModel, toModelJsonSchema } from "../src/language-model.ts"
import { type ModelCall, ModelCallRecorder } from "../src/model-call.ts"

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
  temperature: 0
}

/** A streamed answer (the AI layer always streams). */
const answer = (text: string, finish: "stop" | "length" = "stop") => ({
  stream: simulateReadableStream({
    chunks: [
      { type: "text-start" as const, id: "1" },
      { type: "text-delta" as const, id: "1", delta: text },
      { type: "text-end" as const, id: "1" },
      {
        type: "finish" as const,
        finishReason: { unified: finish, raw: undefined },
        usage: {
          inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 20, text: 20, reasoning: undefined }
        }
      }
    ]
  })
})

const Output = Schema.Struct({ summary: Schema.String, count: Schema.Int })

const request = {
  prompt: { id: "test-task", version: 3 },
  context: { phase: "test-phase", jobId: "job-1" },
  instructions: "Summarize.",
  input: "const secret = '[REDACTED:assigned-secret]'",
  schema: Output
}

/** Runs `generateObject` against a mock model; returns the result (or error) and the call log. */
const run = async (model: MockLanguageModelV4) => {
  const calls: Array<ModelCall> = []
  const recorder = Layer.succeed(
    ModelCallRecorder,
    ModelCallRecorder.of({ record: (call) => Effect.sync(() => void calls.push(call)) })
  )
  const layer = Layer.effect(
    LanguageModel,
    makeLanguageModel({ model, modelId: "test-model", config, retryBaseDelay: "1 millis" })
  ).pipe(Layer.provide(recorder))
  const result = await Effect.runPromise(
    LanguageModel.use((service) => service.generateObject(request)).pipe(Effect.result, Effect.provide(layer))
  )
  return { result, calls }
}

describe("LanguageModel", () => {
  it("returns the decoded answer and records the call without its content", async () => {
    const model = new MockLanguageModelV4({ doStream: answer(`{"summary":"ok","count":2}`) })
    const { result, calls } = await run(model)
    expect(result).toMatchObject({ _tag: "Success", success: { summary: "ok", count: 2 } })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      task: "test-task",
      promptVersion: 3,
      phase: "test-phase",
      jobId: "job-1",
      model: "test-model",
      attempt: 1,
      outcome: "success",
      inputTokens: 100,
      outputTokens: 20,
      error: null
    })
    expect(JSON.stringify(calls)).not.toContain("REDACTED")
    // The JSON schema travels with the request.
    expect(model.doStreamCalls[0]?.responseFormat).toMatchObject({ type: "json", schema: { type: "object" } })
  })

  it("asks for one correction when the answer does not match the schema", async () => {
    const model = new MockLanguageModelV4({
      doStream: [answer(`{"summary":"ok","count":"two"}`), answer(`{"summary":"ok","count":2}`)]
    })
    const { result, calls } = await run(model)
    expect(result).toMatchObject({ _tag: "Success", success: { count: 2 } })
    expect(calls.map((call) => [call.attempt, call.outcome])).toEqual([
      [1, "success"],
      [2, "success"]
    ])
    // The correction request includes the previous answer and the validation problem.
    const prompt = JSON.stringify(model.doStreamCalls[1]?.prompt)
    expect(prompt).toContain(`\\"count\\":\\"two\\"`)
    expect(prompt).toContain("not valid")
  })

  it("asks for a shorter answer when the first one is cut off at the output limit", async () => {
    const model = new MockLanguageModelV4({
      doStream: [answer(`{"summary":"a very long`, "length"), answer(`{"summary":"short","count":1}`)]
    })
    const { result, calls } = await run(model)
    expect(result).toMatchObject({ _tag: "Success", success: { summary: "short" } })
    expect(calls.map((call) => [call.outcome, call.error])).toEqual([
      ["invalid_output", "Truncated at the output token limit"],
      ["success", null]
    ])
    // The truncated answer is not sent back; the request asks for a shorter one.
    const prompt = JSON.stringify(model.doStreamCalls[1]?.prompt)
    expect(prompt).not.toContain("a very long")
    expect(prompt).toContain("cut off")
  })

  it("fails with invalid_output when the correction is invalid too", async () => {
    const model = new MockLanguageModelV4({ doStream: [answer("not json"), answer(`{"summary":1}`)] })
    const { result, calls } = await run(model)
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "AiError", kind: "invalid_output" } })
    expect(calls.map((call) => call.outcome)).toEqual(["invalid_output", "success"])
    expect(model.doStreamCalls).toHaveLength(2)
  })

  it("retries transient provider errors and records each attempt", async () => {
    let attempt = 0
    const model = new MockLanguageModelV4({
      doStream: () => {
        attempt++
        if (attempt < 3) {
          return Promise.reject(
            new APICallError({
              message: "overloaded: echo of the prompt",
              url: "http://localhost/v1/chat/completions",
              requestBodyValues: {},
              statusCode: 503,
              isRetryable: true
            })
          )
        }
        return Promise.resolve(answer(`{"summary":"ok","count":1}`))
      }
    })
    const { result, calls } = await run(model)
    expect(result._tag).toBe("Success")
    expect(calls.map((call) => call.outcome)).toEqual(["error", "error", "success"])
    // Only the error name and status are recorded, never the provider message.
    expect(calls[0]?.error).toBe("AI_APICallError 503")
  })

  it("does not retry errors that cannot be fixed by retrying", async () => {
    const model = new MockLanguageModelV4({
      doStream: () =>
        Promise.reject(
          new APICallError({
            message: "bad request",
            url: "http://localhost/v1/chat/completions",
            requestBodyValues: {},
            statusCode: 400,
            isRetryable: false
          })
        )
    })
    const { result, calls } = await run(model)
    expect(result).toMatchObject({ _tag: "Failure", failure: { kind: "provider", retryable: false } })
    expect(calls).toHaveLength(1)
  })
})

describe("toModelJsonSchema", () => {
  it("describes the output schema as a closed JSON object", () => {
    expect(toModelJsonSchema(Output)).toMatchObject({
      type: "object",
      properties: { summary: { type: "string" }, count: { type: "integer" } },
      required: ["summary", "count"],
      additionalProperties: false
    })
  })
})
