import {
  type CardContent,
  type OutputSchema,
  scriptedEmbeddingModel,
  scriptedLanguageModel,
  type StructuredRequest
} from "@code-to-rag/ai"
import {
  acquisitionPipeline,
  analysisPipeline,
  AppConfig,
  CARD_CHUNK,
  CodeAnalyzer,
  createProject,
  IndexRepository,
  indexingPipeline,
  type Job,
  JobRepository,
  KnowledgeRepository,
  ProjectId,
  ProjectRepository,
  requestNewVersion,
  requestUnderstanding,
  runJob,
  SecretBox,
  setCardStatus,
  SnapshotRepository,
  type SnapshotId,
  understandingPipeline,
  UploadId,
  uploadPath
} from "@code-to-rag/core"
import { Database } from "@code-to-rag/db"
import { makeTestDatabaseLayer, resetDatabase, testDatabaseUrl } from "@code-to-rag/db/testing"
import { sql } from "drizzle-orm"
import { Effect, Layer, ManagedRuntime, Option } from "effect"
import { zipSync } from "fflate"
import { randomBytes, randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as nodePath from "node:path"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { card as ordersCard, defaultRespond } from "./support/understanding.ts"

const url = testDatabaseUrl()
if (url === undefined && process.env["CI"] !== undefined) throw new Error("TEST_DATABASE_URL is required in CI")

const encode = (text: string) => new TextEncoder().encode(text)

const service = (limit: number) =>
  [
    `import { formatPrice } from "../lib/money"`,
    `/** Creates orders. */`,
    `export class OrderService {`,
    `  create(qty: number) {`,
    `    if (qty > ${limit}) throw new Error("Massimo ${limit} pezzi")`,
    `    return formatPrice(qty)`,
    `  }`,
    `}`,
    ``
  ].join("\n")

/** Version 1: orders and prices. */
const version1 = () =>
  zipSync({
    "web/src/orders/service.ts": encode(service(100)),
    "web/src/lib/money.ts": encode(`export function formatPrice(value: number) { return value.toFixed(2) }\n`),
    "config/app.json": encode(`{ "maxOrderQuantity": 100 }\n`),
    "README.md": encode("# Shop\n")
  })

/** Version 2: the order limit changes and refunds appear; prices and configuration are unchanged. */
const version2 = () =>
  zipSync({
    "web/src/orders/service.ts": encode(service(50)),
    "web/src/lib/money.ts": encode(`export function formatPrice(value: number) { return value.toFixed(2) }\n`),
    "web/src/payments/refund.ts": encode(`export function refund(orderId: string) { return orderId }\n`),
    "config/app.json": encode(`{ "maxOrderQuantity": 100 }\n`),
    "README.md": encode("# Shop\n")
  })

/** Version 3: prices are gone (the feature disappears), the README changes. */
const version3 = () =>
  zipSync({
    "web/src/orders/service.ts": encode(service(50)),
    "web/src/payments/refund.ts": encode(`export function refund(orderId: string) { return orderId }\n`),
    "config/app.json": encode(`{ "maxOrderQuantity": 100 }\n`),
    "README.md": encode("# Shop, version 3\n")
  })

const pricesCard: CardContent = {
  title: "Prices",
  summary: "Prices are shown with two decimals.",
  behavior: [
    {
      text: "Formats prices with two decimals.",
      references: [{ path: "web/src/lib/money.ts", startLine: 1, endLine: 1 }]
    }
  ],
  configuration: [],
  parameters: [],
  limits: [],
  validationRules: [],
  errors: []
}

const calls: Array<string> = []
const cardInputs: Array<string> = []

const respond = (request: StructuredRequest<OutputSchema>): unknown => {
  calls.push(request.prompt.id)
  switch (request.prompt.id) {
    case "feature-map":
      return {
        features: [
          { name: "Orders", description: "Create orders.", files: ["web/src/orders/service.ts"], symbols: [] },
          { name: "Prices", description: "Format prices.", files: ["web/src/lib/money.ts"], symbols: ["formatPrice"] }
        ]
      }
    case "feature-update":
      return {
        features: [
          // Existing feature (another spelling): the file is already its own.
          { name: "orders", description: "Ignored.", files: ["web/src/orders/service.ts"], symbols: [] },
          { name: "Refunds", description: "Refund orders.", files: ["web/src/payments/refund.ts"], symbols: ["refund"] }
        ]
      }
    case "card":
      cardInputs.push(request.input)
      return /^Feature: Prices$/m.test(request.input) ? pricesCard : ordersCard
    case "card-verify":
      return { statements: [], missing: [] }
    default:
      return defaultRespond(request)
  }
}

const makeLayer = (databaseUrl: string) =>
  Layer.mergeAll(SecretBox.layer, CodeAnalyzer.layer, scriptedEmbeddingModel(), scriptedLanguageModel(respond)).pipe(
    Layer.provideMerge(AppConfig.layer),
    Layer.provideMerge(makeTestDatabaseLayer(databaseUrl))
  )
type Services = Layer.Success<ReturnType<typeof makeLayer>>

const reviewer = { id: "user-1", name: "Revisore" }

describe.skipIf(url === undefined)("Incremental updates (PostgreSQL)", () => {
  let runtime: ManagedRuntime.ManagedRuntime<Services, unknown>
  let dataDir: string
  const run = <A, E>(effect: Effect.Effect<A, E, Services>) => runtime.runPromise(effect)

  beforeAll(async () => {
    dataDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "code-to-rag-updates-"))
    process.env["DATA_DIR"] = dataDir
    process.env["APP_ENCRYPTION_KEY"] = randomBytes(32).toString("base64")
    process.env["SNAPSHOT_RETENTION"] = "2"
    runtime = ManagedRuntime.make(makeLayer(url!))
    await run(Effect.void)
  })
  afterAll(async () => {
    delete process.env["SNAPSHOT_RETENTION"]
    await runtime.dispose()
    await fs.rm(dataDir, { recursive: true, force: true })
  })
  beforeEach(async () => {
    calls.length = 0
    cardInputs.length = 0
    await run(resetDatabase)
  })

  /** Claims the next queued job and runs it; undefined when the queue is empty. */
  const runNext = async (): Promise<Job | undefined> => {
    const claimed = await run(JobRepository.use((jobs) => jobs.claim("test-worker")))
    if (Option.isNone(claimed)) return undefined
    const job = claimed.value
    if (job.type === "acquisition") await run(runJob(acquisitionPipeline, job))
    else if (job.type === "analysis") await run(runJob(analysisPipeline, job))
    else if (job.type === "understanding") await run(runJob(understandingPipeline, job))
    else if (job.type === "indexing") await run(runJob(indexingPipeline, job))
    else throw new Error(`Unexpected job ${job.type}`)
    return run(JobRepository.use((jobs) => jobs.get(job.id)))
  }

  const runClaimed = async (): Promise<Job> => {
    const job = await runNext()
    if (job === undefined) throw new Error("No queued job")
    return job
  }

  /** Runs queued jobs until the queue is empty; returns them in order. */
  const drain = async (): Promise<Array<Job>> => {
    const done: Array<Job> = []
    for (let job = await runNext(); job !== undefined; job = await runNext()) done.push(job)
    return done
  }

  const upload = async (archive: Uint8Array) => {
    const uploadId = UploadId.make(randomUUID())
    const config = await run(Effect.service(AppConfig))
    await fs.mkdir(config.uploadsDir, { recursive: true })
    await fs.writeFile(uploadPath(config.uploadsDir, uploadId), archive)
    return uploadId
  }

  const project = (projectId: ProjectId) => run(ProjectRepository.use((projects) => projects.get(projectId)))
  const featureMap = (snapshotId: SnapshotId) => run(KnowledgeRepository.use((k) => k.featureMap(snapshotId)))
  const byName = async (snapshotId: SnapshotId) =>
    new Map((await featureMap(snapshotId)).features.map((feature) => [feature.name, feature]))

  /** Version 1 understood, indexed and reviewed: both cards approved. */
  const firstVersion = async () => {
    const summary = await run(
      createProject({ name: "Shop", source: { type: "zip", uploadId: await upload(version1()) } }, null)
    )
    const snapshotId = summary.latestSnapshot!.id
    expect(summary.currentSnapshot?.id).toBe(snapshotId)
    await drain()
    await run(requestUnderstanding(snapshotId))
    const jobs = await drain()
    expect(jobs.map((job) => [job.type, job.status])).toEqual([
      ["understanding", "succeeded"],
      ["indexing", "succeeded"]
    ])
    for (const feature of (await featureMap(snapshotId)).features) {
      await run(setCardStatus(snapshotId, feature.card!.id, "approved", reviewer))
    }
    calls.length = 0
    cardInputs.length = 0
    return { projectId: summary.project.id, snapshotId }
  }

  it("updates a new version: unchanged cards are copied, changed ones rewritten, new ones written", async () => {
    const { projectId, snapshotId: v1 } = await firstVersion()

    const queued = await run(requestNewVersion(projectId, await upload(version2())))
    const v2 = queued.latestSnapshot!.id
    expect(v2).not.toBe(v1)
    expect(queued.currentSnapshot?.id).toBe(v1)
    expect(queued.latestSnapshot?.baseSnapshotId).toBe(v1)
    // The current cards are read by the update: no review while it runs.
    const blocked = await run(
      Effect.flip(setCardStatus(v1, (await byName(v1)).get("Orders")!.card!.id, "excluded", reviewer))
    )
    expect(blocked._tag).toBe("InvalidInputError")

    expect((await runClaimed()).type).toBe("acquisition")
    expect((await runClaimed()).type).toBe("analysis")
    // The analysis recorded the file changes and queued the update.
    const pending = await run(SnapshotRepository.use((s) => s.get(v2)))
    expect(pending.snapshot.changes).toEqual({ files: { added: 1, modified: 1, removed: 0 }, cards: null })
    expect((await project(projectId)).currentSnapshot?.id).toBe(v1)

    const update = await runClaimed()
    expect(update).toMatchObject({ type: "understanding", status: "succeeded", payload: { baseSnapshotId: v1 } })

    // Only what changed went to the model.
    expect(calls.filter((id) => id === "file-summary")).toHaveLength(2)
    expect(calls.filter((id) => id === "module-summary")).toHaveLength(4)
    expect(calls.filter((id) => id === "feature-map")).toHaveLength(0)
    expect(calls.filter((id) => id === "feature-update")).toHaveLength(1)
    expect(calls.filter((id) => id === "card")).toHaveLength(2)
    expect(calls.filter((id) => id === "card-verify")).toHaveLength(2)
    const updatePrompt = cardInputs.find((input) => input.includes("Feature: Orders"))
    expect(updatePrompt).toContain("Current card (update it")
    expect(updatePrompt).toContain("The code changed since the current card was written")
    expect(updatePrompt).toContain("- web/src/orders/service.ts")

    const features = await byName(v2)
    expect([...features.keys()]).toEqual(["Orders", "Prices", "Refunds"])
    const before = await byName(v1)
    expect(features.get("Prices")?.card).toMatchObject({ status: "approved", change: "kept" })
    expect(features.get("Orders")?.card).toMatchObject({ status: "needs_recheck", change: "updated" })
    expect(features.get("Refunds")?.card?.change).toBe("created")

    const prices = await run(KnowledgeRepository.use((k) => k.getCard(v2, features.get("Prices")!.card!.id)))
    expect(prices).toMatchObject({ version: 1, reviewedBy: "Revisore", change: "kept" })
    expect(prices.verification?.cardVersion).toBe(1)
    const orders = await run(KnowledgeRepository.use((k) => k.getCard(v2, features.get("Orders")!.card!.id)))
    expect(orders.version).toBe(2)
    expect(orders.verification?.cardVersion).toBe(2)
    // The previous version keeps its own cards.
    expect(before.get("Orders")?.card).toMatchObject({ status: "approved", change: null })

    // The new version is in use; the index only embeds the rewritten and new cards (copied chunks are reused).
    const summary = await project(projectId)
    expect(summary.currentSnapshot?.id).toBe(v2)
    expect(summary.currentSnapshot?.changes).toEqual({
      files: { added: 1, modified: 1, removed: 0 },
      cards: { kept: 1, updated: 1, created: 1, removed: 0 }
    })
    const embedding = await run(Effect.service(IndexRepository))
    const toIndex = await run(
      embedding.cardsToIndex(v2, { model: "scripted-embedding-model", formatVersion: CARD_CHUNK.version })
    )
    expect(toIndex.map((card) => card.featureName).sort()).toEqual(["Orders", "Refunds"])
    expect((await runClaimed()).type).toBe("indexing")
    const status = await run(
      embedding.status(v2, { model: "scripted-embedding-model", formatVersion: CARD_CHUNK.version })
    )
    expect(status).toMatchObject({ indexableCards: 3, indexedCards: 3 })

    // The same archive again: nothing is created, the job ends on the version in use.
    const again = await run(requestNewVersion(projectId, await upload(version2())))
    const discarded = await runClaimed()
    expect(discarded).toMatchObject({ type: "acquisition", status: "succeeded", snapshotId: v2 })
    expect(discarded.progress?.message).toBe("Nessuna modifica rispetto alla versione in uso")
    const versions = await run(SnapshotRepository.use((s) => s.list(projectId)))
    expect(versions.map((v) => v.id)).toEqual([v2, v1])
    expect(again.latestSnapshot?.id).not.toBe(v2)
    expect(await drain()).toEqual([])
  })

  it("drops vanished features and deletes versions beyond the retention", async () => {
    const { projectId, snapshotId: v1 } = await firstVersion()
    await run(requestNewVersion(projectId, await upload(version2())))
    await drain()
    const v2 = (await project(projectId)).currentSnapshot!.id
    calls.length = 0

    const queued = await run(requestNewVersion(projectId, await upload(version3())))
    const v3 = queued.latestSnapshot!.id
    const jobs = await drain()
    expect(jobs.map((job) => [job.type, job.status])).toEqual([
      ["acquisition", "succeeded"],
      ["analysis", "succeeded"],
      ["understanding", "succeeded"],
      ["indexing", "succeeded"]
    ])
    // No code file changed or appeared: only the modules above the removed file are summarized again.
    expect(calls.filter((id) => id === "file-summary")).toHaveLength(0)
    expect(calls.filter((id) => id === "module-summary")).toHaveLength(2)
    expect(calls.filter((id) => id === "feature-update")).toHaveLength(0)
    expect(calls.filter((id) => id === "card")).toHaveLength(0)

    const features = await byName(v3)
    expect([...features.keys()]).toEqual(["Orders", "Refunds"])
    expect(features.get("Orders")?.card).toMatchObject({ status: "needs_recheck", change: "kept" })
    const summary = await project(projectId)
    expect(summary.currentSnapshot?.id).toBe(v3)
    expect(summary.currentSnapshot?.changes).toEqual({
      files: { added: 0, modified: 1, removed: 1 },
      cards: { kept: 2, updated: 0, created: 0, removed: 1 }
    })

    // SNAPSHOT_RETENTION=2: the first version is gone, with its knowledge.
    const versions = await run(SnapshotRepository.use((s) => s.list(projectId)))
    expect(versions.map((v) => v.id)).toEqual([v3, v2])
    const rag = await run(
      Database.use(({ db }) =>
        Effect.promise(() => db.execute<{ id: string }>(sql`select id from rag.snapshot order by created_at`))
      )
    )
    expect(rag.rows.map((row) => row.id)).toEqual([v2, v3])
    expect(rag.rows.map((row) => row.id)).not.toContain(v1)
  })

  it("makes a new version current at once when the version in use has no cards", async () => {
    const summary = await run(
      createProject({ name: "Shop", source: { type: "zip", uploadId: await upload(version1()) } }, null)
    )
    await drain()
    const queued = await run(requestNewVersion(summary.project.id, await upload(version2())))
    const v2 = queued.latestSnapshot!.id
    expect((await drain()).map((job) => job.type)).toEqual(["acquisition", "analysis"])
    const after = await project(summary.project.id)
    expect(after.currentSnapshot?.id).toBe(v2)
    expect(after.currentSnapshot?.understandingStatus).toBeNull()
    // Git projects take no archive; zip projects need one.
    const missing = await run(Effect.flip(requestNewVersion(summary.project.id, null)))
    expect(missing._tag).toBe("InvalidInputError")
  })
})
