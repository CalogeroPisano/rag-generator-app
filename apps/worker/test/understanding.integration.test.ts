import {
  AiConfig,
  AiError,
  type CardContent,
  makeLanguageModel,
  type OutputSchema,
  RollupOutput,
  scriptedLanguageModel,
  type StructuredRequest
} from "@code-to-rag/ai"
import {
  acquisitionPipeline,
  analysisPipeline,
  AppConfig,
  CodeAnalyzer,
  createProject,
  type Job,
  JobRepository,
  KnowledgeRepository,
  requestUnderstanding,
  runJob,
  SecretBox,
  SnapshotRepository,
  type SnapshotId,
  UnderstandingRepository,
  understandingPipeline,
  UploadId,
  uploadPath
} from "@code-to-rag/core"
import { Database } from "@code-to-rag/db"
import { makeTestDatabaseLayer, resetDatabase, testDatabaseUrl } from "@code-to-rag/db/testing"
import { simulateReadableStream } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import { sql } from "drizzle-orm"
import { Effect, Layer, ManagedRuntime, Option } from "effect"
import { zipSync } from "fflate"
import { randomBytes, randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as nodePath from "node:path"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

const url = testDatabaseUrl()
if (url === undefined && process.env["CI"] !== undefined) throw new Error("TEST_DATABASE_URL is required in CI")

const encode = (text: string) => new TextEncoder().encode(text)

/** Answers of the scripted model, chosen per prompt; tests replace it to inject failures. */
let respond: (request: StructuredRequest<OutputSchema>) => unknown = () => undefined
const calls: Array<string> = []

const makeLayer = (databaseUrl: string) =>
  Layer.mergeAll(
    SecretBox.layer,
    CodeAnalyzer.layer,
    scriptedLanguageModel((request) => {
      calls.push(request.prompt.id)
      return respond(request)
    })
  ).pipe(Layer.provideMerge(AppConfig.layer), Layer.provideMerge(makeTestDatabaseLayer(databaseUrl)))
type Services = Layer.Success<ReturnType<typeof makeLayer>>

const sampleProject = () =>
  zipSync({
    "web/src/orders/service.ts": encode(
      [
        `import { formatPrice } from "../lib/money"`,
        `/** Creates orders. */`,
        `export class OrderService {`,
        `  create(qty: number) {`,
        `    if (qty > 100) throw new Error("Massimo 100 pezzi")`,
        `    return formatPrice(qty)`,
        `  }`,
        `}`,
        ``
      ].join("\n")
    ),
    "web/src/lib/money.ts": encode(`export function formatPrice(value: number) { return value.toFixed(2) }\n`),
    "web/src/orders/service.test.ts": encode(`import { OrderService } from "./service"\n`),
    "config/app.json": encode(`{ "maxOrderQuantity": 100 }\n`),
    "README.md": encode("# Shop\n")
  })

const card: CardContent = {
  title: "Orders",
  summary: "Users can create orders.",
  behavior: [
    {
      text: "Creates an order for the given quantity.",
      references: [{ path: "web/src/orders/service.ts", startLine: 4, endLine: 7 }]
    }
  ],
  configuration: [],
  parameters: [
    {
      name: "qty",
      description: "Quantity to order",
      type: "number",
      required: true,
      defaultValue: null,
      references: [{ path: "web/src/orders/service.ts", startLine: 4, endLine: 4 }]
    }
  ],
  limits: [
    // Invented file: dropped by the reference check.
    { text: "At most 100 pieces.", references: [{ path: "web/src/invented.ts", startLine: 1, endLine: 2 }] }
  ],
  validationRules: [],
  errors: [
    {
      condition: "Quantity above 100",
      message: "Massimo 100 pezzi",
      references: [{ path: "web/src/orders/service.ts", startLine: 5, endLine: 5 }]
    }
  ]
}

/** A plausible answer for every prompt of the pipeline. */
const defaultRespond = (request: StructuredRequest<OutputSchema>): unknown => {
  switch (request.prompt.id) {
    case "file-summary": {
      const path = /^File: (\S+)/.exec(request.input)?.[1] ?? "?"
      const names = [...request.input.matchAll(/^- \w+ (\S+) \(lines/gm)].map((m) => m[1])
      return { summary: `Summary of ${path}.`, symbols: names.map((name) => ({ name, summary: `About ${name}.` })) }
    }
    case "module-summary":
      return { summary: `Module ${/^Module: (.+)$/m.exec(request.input)?.[1] ?? "?"}.` }
    case "feature-map":
      return {
        features: [
          {
            name: "Orders",
            description: "Create orders.",
            files: ["web/src/orders/service.ts", "web/src/lib/money.ts", "web/src/invented.ts"],
            symbols: ["OrderService.create", "formatPrice"]
          },
          { name: "Ghost", description: "Not in the code.", files: ["nowhere.ts"], symbols: [] }
        ]
      }
    case "card":
      return card
    default:
      return undefined
  }
}

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
    if (job.type === "acquisition") await run(runJob(acquisitionPipeline, job))
    else if (job.type === "analysis") await run(runJob(analysisPipeline, job))
    else await run(runJob(understandingPipeline, job))
    return run(JobRepository.use((jobs) => jobs.get(job.id)))
  }

  const acquireAndAnalyze = async (): Promise<SnapshotId> => {
    const uploadId = UploadId.make(randomUUID())
    const config = await run(Effect.service(AppConfig))
    await fs.mkdir(config.uploadsDir, { recursive: true })
    await fs.writeFile(uploadPath(config.uploadsDir, uploadId), sampleProject())
    const summary = await run(createProject({ name: "Shop", source: { type: "zip", uploadId } }, null))
    const snapshotId = summary.latestSnapshot!.id
    expect((await runClaimed()).type).toBe("acquisition")
    // Understanding needs the static analysis first.
    const early = await run(Effect.flip(requestUnderstanding(snapshotId)))
    expect(early._tag).toBe("InvalidInputError")
    expect((await runClaimed()).status).toBe("succeeded")
    return snapshotId
  }

  it("summarizes, maps features and writes cards into the rag schema", async () => {
    const snapshotId = await acquireAndAnalyze()
    const queued = await run(requestUnderstanding(snapshotId))
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
      card: { status: "generated", title: "Orders", unreferencedStatements: 1 }
    })

    const view = await run(KnowledgeRepository.use((k) => k.getCard(snapshotId, feature.card!.id)))
    expect(view.featureName).toBe("Orders")
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
    await run(requestUnderstanding(snapshotId))
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
    expect(calls).toEqual(["card"])
  })

  it("skips files whose answer stays invalid and starts over on a new request", async () => {
    const snapshotId = await acquireAndAnalyze()
    await run(requestUnderstanding(snapshotId))
    respond = (request) =>
      request.prompt.id === "file-summary" && request.input.startsWith("File: config/app.json")
        ? new AiError({ kind: "invalid_output", message: "invalid", retryable: false })
        : defaultRespond(request)
    expect((await runClaimed()).status).toBe("succeeded")
    const first = await run(KnowledgeRepository.use((k) => k.fileSummaries(snapshotId)))
    expect(first.map((s) => s.path)).toEqual(["web/src/lib/money.ts", "web/src/orders/service.ts"])

    respond = defaultRespond
    await run(requestUnderstanding(snapshotId))
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
