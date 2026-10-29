import { Duration, Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { DecisionModel, type ModelCall, ModelCallRecorder } from "@code-to-rag/core/outbound"
import type { DecisionConfigShape } from "../src/config.ts"
import { makeDecisionModel } from "../src/decision-model.ts"

const config: DecisionConfigShape = {
  baseUrl: "http://localhost:11434",
  model: "d1-omni",
  timeout: Duration.seconds(5),
  maxRetries: 2,
  concurrency: 1,
  contextTokens: 8192,
  maxQuestions: 64,
  keepAlive: "10m"
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const run = async (respond: (body: Record<string, unknown>) => Response) => {
  const calls: Array<ModelCall> = []
  const requests: Array<{ url: string; body: Record<string, unknown> }> = []
  const recorder = Layer.succeed(
    ModelCallRecorder,
    ModelCallRecorder.of({ record: (call) => Effect.sync(() => void calls.push(call)) })
  )
  const fetch = ((url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    requests.push({ url, body })
    return Promise.resolve(respond(body))
  }) as unknown as typeof globalThis.fetch
  const layer = Layer.effect(DecisionModel, makeDecisionModel({ config, fetch, retryBaseDelay: "1 millis" })).pipe(
    Layer.provide(recorder)
  )
  const result = await Effect.runPromise(
    DecisionModel.use((service) =>
      service.decide({
        prompt: { id: "card-verify", version: 2 },
        context: { phase: "verify-cards", jobId: "job-1" },
        state: "secret source code",
        questions: {
          "behavior.0": { instructions: "Is it true?" },
          missing: { instructions: "Anything missing?", criteria: { true: "yes", false: "no" } }
        }
      })
    ).pipe(Effect.result, Effect.provide(layer))
  )
  return { result, calls, requests }
}

describe("DecisionModel", () => {
  it("asks yes/no questions to /v1/systemone and records metadata only", async () => {
    const { result, calls, requests } = await run(() =>
      json({
        model: "d1-omni",
        answers: { "behavior.0": { type: "noul", noul: 0.91 }, missing: { type: "noul", noul: 0.12 } },
        usage: { input_tokens: 120, output_tokens: 0 }
      })
    )
    expect(result).toMatchObject({ _tag: "Success", success: { "behavior.0": 0.91, missing: 0.12 } })
    expect(requests[0]?.url).toBe("http://localhost:11434/v1/systemone")
    expect(requests[0]?.body).toEqual({
      model: "d1-omni",
      state: "secret source code",
      keep_alive: "10m",
      questions: {
        "behavior.0": { type: "noul", instructions: "Is it true?" },
        missing: { type: "noul", instructions: "Anything missing?", criteria: { true: "yes", false: "no" } }
      }
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      task: "card-verify",
      promptVersion: 2,
      provider: "ollama",
      model: "d1-omni",
      outcome: "success",
      inputTokens: 120,
      outputTokens: 0,
      phase: "verify-cards",
      jobId: "job-1"
    })
    expect(JSON.stringify(calls)).not.toContain("secret source code")
  })

  it("retries transient errors", async () => {
    let attempt = 0
    const { result, calls } = await run(() => {
      attempt++
      if (attempt === 1) return json({ error: "busy" }, 503)
      return json({ answers: { "behavior.0": { type: "noul", noul: 1 }, missing: { type: "noul", noul: 0 } } })
    })
    expect(result._tag).toBe("Success")
    expect(calls.map((call) => [call.outcome, call.error])).toEqual([
      ["error", "HttpStatusError 503"],
      ["success", null]
    ])
  })

  it("fails without retrying when the model is not pulled", async () => {
    const { result, calls } = await run(() => json({ error: "model 'd1-omni' not found" }, 404))
    expect(result).toMatchObject({ _tag: "Failure", failure: { kind: "provider", retryable: false } })
    expect(result._tag === "Failure" && result.failure.message).toContain("ollama pull d1-omni")
    expect(calls).toHaveLength(1)
  })

  it("rejects answers that do not cover every question", async () => {
    const { result, calls } = await run(() => json({ answers: { "behavior.0": { type: "noul", noul: 0.5 } } }))
    expect(result).toMatchObject({ _tag: "Failure", failure: { kind: "invalid_output" } })
    expect(calls.map((call) => call.outcome)).toEqual(["invalid_output"])
  })
})
