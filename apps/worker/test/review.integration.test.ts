import {
  type OutputSchema,
  scriptedEmbeddingModel,
  scriptedLanguageModel,
  type StructuredRequest
} from "@code-to-rag/ai"
import {
  acquisitionPipeline,
  analysisPipeline,
  AppConfig,
  cardPipeline,
  CodeAnalyzer,
  correctCard,
  createProject,
  deleteProject,
  editCard,
  type Job,
  JobRepository,
  KnowledgeRepository,
  ProjectId,
  ProjectRepository,
  requestCardOperation,
  requestUnderstanding,
  runJob,
  SecretBox,
  setCardStatus,
  type SnapshotId,
  understandingPipeline,
  UploadId,
  uploadPath
} from "@code-to-rag/core"
import { Database } from "@code-to-rag/db"
import { makeTestDatabaseLayer, resetDatabase, testDatabaseUrl } from "@code-to-rag/db/testing"
import { sql } from "drizzle-orm"
import { Effect, Layer, ManagedRuntime, Option } from "effect"
import { randomBytes, randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as nodePath from "node:path"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { card, defaultRespond, sampleProject } from "./support/understanding.ts"

const url = testDatabaseUrl()
if (url === undefined && process.env["CI"] !== undefined) throw new Error("TEST_DATABASE_URL is required in CI")

let respond: (request: StructuredRequest<OutputSchema>) => unknown = defaultRespond
const requests: Array<StructuredRequest<OutputSchema>> = []

const makeLayer = (databaseUrl: string) =>
  Layer.mergeAll(
    SecretBox.layer,
    CodeAnalyzer.layer,
    // Embeddings not configured: no indexing jobs in the queue of these tests.
    scriptedEmbeddingModel({ configured: false }),
    scriptedLanguageModel((request) => {
      requests.push(request)
      return respond(request)
    })
  ).pipe(Layer.provideMerge(AppConfig.layer), Layer.provideMerge(makeTestDatabaseLayer(databaseUrl)))
type Services = Layer.Success<ReturnType<typeof makeLayer>>

const reviewer = { id: "user-1", name: "Revisore" }

/** A verification that finds nothing to report. */
const cleanVerification = (request: StructuredRequest<OutputSchema>) => {
  const ids = [...request.input.matchAll(/^- \[([a-zA-Z]+\.\d+)\]/gm)].map((m) => m[1])
  return { statements: ids.map((id) => ({ id, verdict: "supported", note: "" })), missing: [] }
}

describe.skipIf(url === undefined)("card review (PostgreSQL)", () => {
  let runtime: ManagedRuntime.ManagedRuntime<Services, unknown>
  let dataDir: string
  const run = <A, E>(effect: Effect.Effect<A, E, Services>) => runtime.runPromise(effect)

  beforeAll(async () => {
    dataDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "code-to-rag-review-"))
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
    requests.length = 0
    await run(resetDatabase)
  })

  const runClaimed = async (): Promise<Job> => {
    const job = await run(JobRepository.use((jobs) => jobs.claim("test-worker"))).then(Option.getOrThrow)
    switch (job.type) {
      case "acquisition":
        await run(runJob(acquisitionPipeline, job))
        break
      case "analysis":
        await run(runJob(analysisPipeline, job))
        break
      case "understanding":
        await run(runJob(understandingPipeline, job))
        break
      case "card":
        await run(runJob(cardPipeline, job))
    }
    return run(JobRepository.use((jobs) => jobs.get(job.id)))
  }

  /** Acquires, analyzes and understands the sample project; returns the ids of the only card. */
  const understood = async () => {
    const uploadId = UploadId.make(randomUUID())
    const config = await run(Effect.service(AppConfig))
    await fs.mkdir(config.uploadsDir, { recursive: true })
    await fs.writeFile(uploadPath(config.uploadsDir, uploadId), sampleProject())
    const summary = await run(createProject({ name: "Shop", source: { type: "zip", uploadId } }, null))
    const snapshotId: SnapshotId = summary.latestSnapshot!.id
    await runClaimed()
    await runClaimed()
    await run(requestUnderstanding(snapshotId))
    expect((await runClaimed()).status).toBe("succeeded")
    const map = await run(KnowledgeRepository.use((k) => k.featureMap(snapshotId)))
    const feature = map.features[0]!
    return { projectId: summary.project.id, snapshotId, featureId: feature.id, cardId: feature.card!.id }
  }

  const currentCard = async (snapshotId: SnapshotId, featureId: string) => {
    const map = await run(KnowledgeRepository.use((k) => k.featureMap(snapshotId)))
    const cardId = map.features.find((f) => f.id === featureId)!.card!.id
    return run(KnowledgeRepository.use((k) => k.getCard(snapshotId, cardId)))
  }

  it("verifies a card on demand and keeps review decisions", async () => {
    const { snapshotId, featureId, cardId } = await understood()
    expect((await currentCard(snapshotId, featureId)).status).toBe("flagged")

    await run(setCardStatus(snapshotId, cardId, "approved", reviewer))
    respond = (request) => (request.prompt.id === "card-verify" ? cleanVerification(request) : defaultRespond(request))
    const job = await run(requestCardOperation(snapshotId, cardId, "verify"))
    // One active job per card: asking again returns the same job.
    expect((await run(requestCardOperation(snapshotId, cardId, "verify"))).id).toBe(job.id)
    expect((await runClaimed()).status).toBe("succeeded")

    const view = await currentCard(snapshotId, featureId)
    // Only the statement without references is still an issue; the approval is kept.
    expect(view.verification?.issues).toBe(1)
    expect(view).toMatchObject({ status: "approved", reviewedBy: "Revisore" })
  })

  it("applies corrections when correcting and regenerating, and keeps them", async () => {
    const { snapshotId, featureId, cardId } = await understood()
    respond = (request) =>
      request.prompt.id === "card"
        ? {
            ...card,
            limits: [
              {
                text: "At most 100 pieces per order.",
                references: [{ path: "web/src/orders/service.ts", startLine: 5, endLine: 5 }]
              }
            ]
          }
        : request.prompt.id === "card-verify"
          ? cleanVerification(request)
          : defaultRespond(request)

    await run(correctCard(snapshotId, cardId, "The limit is in service.ts, line 5.", reviewer))
    expect((await runClaimed()).status).toBe("succeeded")
    const corrected = await currentCard(snapshotId, featureId)
    expect(corrected).toMatchObject({ status: "in_review", version: 2, unreferencedStatements: 0 })
    expect(corrected.corrections).toMatchObject([
      { text: "The limit is in service.ts, line 5.", authorName: "Revisore", appliedVersion: 2 }
    ])
    // The model got the current card and the correction.
    const correctRequest = requests.findLast((r) => r.prompt.id === "card")!
    expect(correctRequest.input).toContain("Current card")
    expect(correctRequest.input).toContain("The limit is in service.ts, line 5.")

    requests.length = 0
    await run(requestCardOperation(snapshotId, corrected.id, "regenerate"))
    expect((await runClaimed()).status).toBe("succeeded")
    const regenerated = await currentCard(snapshotId, featureId)
    expect(regenerated).toMatchObject({ status: "generated", version: 3 })
    expect(regenerated.corrections[0]?.appliedVersion).toBe(3)
    const regenerateRequest = requests.find((r) => r.prompt.id === "card")!
    expect(regenerateRequest.input).not.toContain("Current card")
    expect(regenerateRequest.input).toContain("Reviewer corrections")
  })

  it("re-attaches corrections by feature name after a new feature map", async () => {
    const { snapshotId, cardId } = await understood()
    await run(correctCard(snapshotId, cardId, "Mention the 100 pieces limit.", reviewer))
    await runClaimed()

    // Card jobs and understanding exclude each other.
    await run(requestUnderstanding(snapshotId))
    const blocked = await run(Effect.flip(requestCardOperation(snapshotId, cardId, "verify")))
    expect(blocked._tag).toBe("InvalidInputError")
    expect((await runClaimed()).status).toBe("succeeded")

    const map = await run(KnowledgeRepository.use((k) => k.featureMap(snapshotId)))
    const view = await run(KnowledgeRepository.use((k) => k.getCard(snapshotId, map.features[0]!.card!.id)))
    expect(view.corrections.map((c) => c.text)).toEqual(["Mention the 100 pieces limit."])
    expect(view.corrections[0]?.appliedVersion).toBe(1)

    // A map without that feature name leaves the correction orphan.
    respond = (request) =>
      request.prompt.id === "feature-map"
        ? {
            features: [{ name: "Order pricing", description: "Prices.", files: ["web/src/lib/money.ts"], symbols: [] }]
          }
        : defaultRespond(request)
    await run(requestUnderstanding(snapshotId))
    await runClaimed()
    const renamed = await run(KnowledgeRepository.use((k) => k.featureMap(snapshotId)))
    expect(renamed.orphanCorrections.map((c) => c.featureName)).toEqual(["Orders"])
  })

  it("edits a card by hand, dropping references to lines that do not exist", async () => {
    const { snapshotId, featureId, cardId } = await understood()
    await run(
      editCard(
        snapshotId,
        cardId,
        {
          ...card,
          title: "Orders (edited)",
          limits: [
            {
              text: "At most 100 pieces.",
              references: [{ path: "web/src/orders/service.ts", startLine: 5, endLine: 5 }]
            }
          ],
          behavior: [
            {
              text: "Creates an order.",
              references: [{ path: "web/src/orders/service.ts", startLine: 400, endLine: 410 }]
            }
          ]
        },
        reviewer
      )
    )
    const view = await currentCard(snapshotId, featureId)
    expect(view).toMatchObject({ status: "in_review", version: 2, unreferencedStatements: 1, reviewedBy: "Revisore" })
    expect(view.content.title).toBe("Orders (edited)")
    // The stored verification belongs to version 1: it is outdated and the card is verified again.
    const map = await run(KnowledgeRepository.use((k) => k.featureMap(snapshotId)))
    expect(map.features[0]?.card?.issues).toBeNull()
    expect(await run(KnowledgeRepository.use((k) => k.cardsToVerify(snapshotId)))).toEqual([cardId])
  })

  it("deletes a project with its knowledge, refusing while a job runs", async () => {
    const { projectId, snapshotId, cardId } = await understood()
    await run(correctCard(snapshotId, cardId, "Something to fix.", reviewer))
    // The queued card job is deleted with the project, a running one blocks the deletion.
    const claimed = await run(JobRepository.use((jobs) => jobs.claim("test-worker"))).then(Option.getOrThrow)
    const refused = await run(Effect.flip(deleteProject(ProjectId.make(projectId))))
    expect(refused._tag).toBe("InvalidInputError")
    await run(JobRepository.use((jobs) => jobs.release(claimed.id)))

    await run(deleteProject(ProjectId.make(projectId)))
    const missing = await run(Effect.flip(ProjectRepository.use((p) => p.get(ProjectId.make(projectId)))))
    expect(missing._tag).toBe("NotFoundError")
    const count = (table: string) =>
      run(
        Database.use(({ db }) =>
          Effect.promise(() => db.execute<{ total: number }>(sql.raw(`select count(*)::int as total from ${table}`)))
        )
      ).then((result) => result.rows[0]?.total)
    expect(await count("rag.snapshot")).toBe(0)
    expect(await count("rag.correction")).toBe(0)
    expect(await count("rag.card")).toBe(0)
    expect(await count("source_blob")).toBe(0)
    expect(await count("job")).toBe(0)
  })
})
