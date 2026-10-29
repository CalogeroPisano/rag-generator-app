import { AiConfig, makeLanguageModel } from "@code-to-rag/openai"
import { AiError, type DecisionRequest, type OutputSchema, type StructuredRequest } from "@code-to-rag/core/outbound"
import { RollupOutput } from "@code-to-rag/core/testing"
import { scriptedDecisionModel, scriptedEmbeddingModel, scriptedLanguageModel } from "@code-to-rag/core/testing"
import { AppConfig, type Job, Jobs, Knowledge, Projects, type SnapshotId, UploadId } from "@code-to-rag/core"
import {
  JobRepository,
  KnowledgeRepository,
  SnapshotRepository,
  UnderstandingRepository
} from "@code-to-rag/core/outbound"
import { Database } from "@code-to-rag/postgres"
import { makeTestDatabaseLayer, resetDatabase, testDatabaseUrl } from "@code-to-rag/postgres/testing"
import { simulateReadableStream } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import { sql } from "drizzle-orm"
import { Effect, Layer, ManagedRuntime, Option } from "effect"
import { randomBytes, randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as nodePath from "node:path"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { defaultDecide, defaultRespond, sampleProject } from "./support/understanding.ts"
import { storeUpload, testAdapters } from "./support/adapters.ts"

const url = testDatabaseUrl()
if (url === undefined && process.env["CI"] !== undefined) throw new Error("TEST_DATABASE_URL is required in CI")

/** Answers of the scripted model, chosen per prompt; tests replace it to inject failures. */
let respond: (request: StructuredRequest<OutputSchema>) => unknown = () => undefined
const calls: Array<string> = []
const decisions: Array<DecisionRequest> = []

const makeLayer = (databaseUrl: string) =>
  Layer.mergeAll(
    testAdapters,
    // Embeddings not configured: no indexing jobs in the queue of these tests.
    scriptedEmbeddingModel({ configured: false }),
    scriptedLanguageModel((request) => {
      calls.push(request.prompt.id)
      return respond(request)
    }),
    scriptedDecisionModel((request) => {
      calls.push(request.prompt.id)
      decisions.push(request)
      return defaultDecide(request)
    })
  ).pipe(Layer.provideMerge(AppConfig.layer), Layer.provideMerge(makeTestDatabaseLayer(databaseUrl)))
type Services = Layer.Success<ReturnType<typeof makeLayer>>

describe.skipIf(url === undefined)("AI understanding pipeline (PostgreSQL)", () => {
  let runtime: ManagedRuntime.ManagedRuntime<Services, unknown>
  let dataDir: string
  const run = <A, E>(effect: Effect.Effect<A, E, Services>) => runtime.runPromise(effect)

  beforeAll(async () => {
    dataDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "code-to-rag-understanding-"))
    process.env["DATA_DIR"] = dataDir
    process.env["APP_ENCRYPTION_KEY"] = randomBytes(32).toString("base64")
    runtime = ManagedRuntime.make(makeLayer(url!))
    await run(Effect.void)
  })
  afterAll(async () => {
    await runtime.dispose()
    await fs.rm(dataDir, { recursive: true, force: true })
  })
  beforeEach(async () => {
    respond = defaultRespond
    calls.length = 0
    await run(resetDatabase)
  })

  const runClaimed = async (): Promise<Job> => {
    const job = await run(JobRepository.use((jobs) => jobs.claim("test-worker"))).then(Option.getOrThrow)
    if (job.type === "acquisition") await run(Jobs.runJob(Jobs.acquisitionPipeline, job))
    else if (job.type === "analysis") await run(Jobs.runJob(Jobs.analysisPipeline, job))
    else await run(Jobs.runJob(Jobs.understandingPipeline, job))
    return run(JobRepository.use((jobs) => jobs.get(job.id)))
  }

  const acquireAndAnalyze = async (): Promise<SnapshotId> => {
    const uploadId = UploadId.make(randomUUID())
    await run(storeUpload(uploadId, sampleProject()))
    const summary = await run(Projects.createProject({ name: "Shop", source: { type: "zip", uploadId } }, null))
    const snapshotId = summary.latestSnapshot!.id
    expect((await runClaimed()).type).toBe("acquisition")
    // Understanding needs the static analysis first.
    const early = await run(Effect.flip(Knowledge.requestUnderstanding(snapshotId)))
    expect(early._tag).toBe("InvalidInputError")
    expect((await runClaimed()).status).toBe("succeeded")
    return snapshotId
  }

  it("summarizes, maps features and writes cards into the rag schema", async () => {
    const snapshotId = await acquireAndAnalyze()
    const queued = await run(Knowledge.requestUnderstanding(snapshotId))
    expect(queued.type).toBe("understanding")
    expect((await run(SnapshotRepository.use((s) => s.get(snapshotId)))).snapshot.understandingStatus).toBe("pending")

    const job = await runClaimed()
    expect(job.status).toBe("succeeded")
    expect(job.completedPhases).toEqual([
      "prepare",
      "summarize-files",
      "summarize-modules",
      "map-features",
      "generate-cards",
      "verify-cards",
      "finalize"
    ])

    const { snapshot } = await run(SnapshotRepository.use((s) => s.get(snapshotId)))
    expect(snapshot).toMatchObject({ understandingStatus: "ready", featureCount: 1, cardCount: 1 })

    // Tests and docs are not summarized; configuration is.
    expect(calls.filter((id) => id === "file-summary")).toHaveLength(3)
    const service = await run(KnowledgeRepository.use((k) => k.fileSummary(snapshotId, "web/src/orders/service.ts")))
    expect(Option.getOrThrow(service)).toMatchObject({
      summary: "Summary of web/src/orders/service.ts.",
      model: "scripted-test-model",
      symbols: [
        { qualifiedName: "OrderService", kind: "class", startLine: 3, endLine: 8 },
        { qualifiedName: "OrderService.create", kind: "method", startLine: 4, endLine: 7 }
      ]
    })

    const map = await run(KnowledgeRepository.use((k) => k.featureMap(snapshotId)))
    expect(map.projectSummary).toBe("Module (project root).")
    expect(map.features).toHaveLength(1)
    const feature = map.features[0]!
    expect(feature).toMatchObject({
      name: "Orders",
      files: ["web/src/orders/service.ts", "web/src/lib/money.ts"],
      symbols: [
        { path: "web/src/orders/service.ts", qualifiedName: "OrderService.create" },
        { path: "web/src/lib/money.ts", qualifiedName: "formatPrice" }
      ],
      // Verification: 1 unsupported statement + 1 missing rule + 1 statement without references.
      card: { status: "flagged", title: "Orders", unreferencedStatements: 1, issues: 3 }
    })

    const view = await run(KnowledgeRepository.use((k) => k.getCard(snapshotId, feature.card!.id)))
    expect(view.feature.name).toBe("Orders")
    expect(view.verification).toMatchObject({
      cardVersion: 1,
      issues: 3,
      model: "scripted-decision-model + scripted-test-model",
      missing: [{ section: "validationRules", references: [{ path: "web/src/orders/service.ts", startLine: 5 }] }]
    })
    expect(view.verification?.statements.map((s) => [s.verdict, s.probability])).toEqual([
      ["supported", 0.95],
      ["supported", 0.92],
      ["unsupported", 0.05],
      ["supported", 0.9]
    ])
    // Statements citing code are asked about their lines only; the limit lost its reference and is asked about the
    // whole feature.
    const verifyRequests = decisions.filter((d) => d.prompt.id === "card-verify")
    expect(verifyRequests.map((d) => Object.keys(d.questions))).toEqual([
      ["behavior.0"],
      ["parameters.0"],
      ["errors.0"],
      ["limits.0"]
    ])
    expect(verifyRequests[0]?.state).toContain("Source code cited by the statement")
    expect(verifyRequests[0]?.state).not.toContain("money.ts")
    expect(verifyRequests[3]?.state).toContain("web/src/lib/money.ts")
    expect(view.verification?.statements.map((s) => s.id)).toEqual([
      "behavior.0",
      "parameters.0",
      "limits.0",
      "errors.0"
    ])
    expect(view.content.limits[0]?.references).toEqual([])
    expect(view.content.errors[0]?.references).toEqual([
      { path: "web/src/orders/service.ts", startLine: 5, endLine: 5 }
    ])
    expect(view.sourceRevision).toBe(snapshot.contentHash)

    // The rag schema is self-contained: no foreign key points outside it.
    const foreignKeys = await run(
      Database.use(({ db }) =>
        Effect.promise(() =>
          db.execute(sql`
            select count(*)::int as total
            from information_schema.referential_constraints rc
            join information_schema.table_constraints tc on tc.constraint_name = rc.constraint_name
            join information_schema.constraint_column_usage ccu on ccu.constraint_name = rc.constraint_name
            where tc.table_schema = 'rag' and ccu.table_schema <> 'rag'`)
        )
      )
    )
    expect(foreignKeys.rows[0]).toEqual({ total: 0 })
  })

  it("resumes from the failed phase without paying again for stored summaries", async () => {
    const snapshotId = await acquireAndAnalyze()
    await run(Knowledge.requestUnderstanding(snapshotId))
    respond = (request) =>
      request.prompt.id === "card"
        ? new AiError({ kind: "provider", message: "Errore del modello (503)", retryable: true })
        : defaultRespond(request)
    const failed = await runClaimed()
    expect(failed.status).toBe("queued")
    expect(failed.lastError).toContain("generate-cards")

    respond = defaultRespond
    calls.length = 0
    await run(JobRepository.use((jobs) => jobs.retry(failed.id)).pipe(Effect.ignore))
    // Make the job runnable now instead of after the backoff.
    await run(Database.use(({ db }) => Effect.promise(() => db.execute(sql`update job set run_after = now()`))))
    const resumed = await runClaimed()
    expect(resumed.status).toBe("succeeded")
    // One card written again, verified with four decision requests (three cited ranges + the whole feature) and the
    // missing items prompt.
    expect(calls).toEqual(["card", "card-verify", "card-verify", "card-verify", "card-verify", "card-missing"])
  })

  it("skips files whose answer stays invalid and starts over on a new request", async () => {
    const snapshotId = await acquireAndAnalyze()
    await run(Knowledge.requestUnderstanding(snapshotId))
    respond = (request) =>
      request.prompt.id === "file-summary" && request.input.startsWith("File: config/app.json")
        ? new AiError({ kind: "invalid_output", message: "invalid", retryable: false })
        : defaultRespond(request)
    expect((await runClaimed()).status).toBe("succeeded")
    const first = await run(KnowledgeRepository.use((k) => k.fileSummaries(snapshotId)))
    expect(first.map((s) => s.path)).toEqual(["web/src/lib/money.ts", "web/src/orders/service.ts"])

    respond = defaultRespond
    await run(Knowledge.requestUnderstanding(snapshotId))
    expect((await runClaimed()).status).toBe("succeeded")
    const second = await run(KnowledgeRepository.use((k) => k.fileSummaries(snapshotId)))
    expect(second).toHaveLength(3)
  })

  it("records every model call without its content", async () => {
    const snapshotId = await acquireAndAnalyze()
    const model = new MockLanguageModelV4({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "1" },
            { type: "text-delta", id: "1", delta: `{"summary":"ok"}` },
            { type: "text-end", id: "1" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: undefined },
              usage: {
                inputTokens: { total: 50, noCache: 50, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: 5, text: 5, reasoning: undefined }
              }
            }
          ]
        })
      }
    })
    const program = Effect.gen(function* () {
      const config = yield* AiConfig
      const service = yield* makeLanguageModel({ model, modelId: "mock-model", config })
      yield* service.generateObject({
        prompt: { id: "module-summary", version: 1 },
        context: { phase: "summarize-modules", snapshotId },
        instructions: "Summarize.",
        input: "secret code",
        schema: RollupOutput
      })
      return yield* UnderstandingRepository.use((u) => u.modelCallStats(snapshotId))
    })
    const stats = await run(program.pipe(Effect.provide(AiConfig.layer)))
    expect(stats.total).toMatchObject({ calls: 1, failures: 0, inputTokens: 50, outputTokens: 5 })
    expect(stats.byTask.map((row) => row.task)).toEqual(["module-summary"])
    expect(stats.models).toEqual(["mock-model"])
    const rows = await run(
      Database.use(({ db }) =>
        Effect.promise(() => db.execute(sql`select row_to_json(m)::text as row from model_call m`))
      )
    )
    expect(JSON.stringify(rows.rows)).not.toContain("secret code")
  })
})
