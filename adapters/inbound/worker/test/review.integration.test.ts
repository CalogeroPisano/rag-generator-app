import { AppConfig, type Job, Jobs, Knowledge, ProjectId, Projects, type SnapshotId, UploadId } from "@code-to-rag/core"
import {
  JobRepository,
  KnowledgeRepository,
  type OutputSchema,
  ProjectRepository,
  SnapshotRepository,
  type DecisionRequest,
  type StructuredRequest
} from "@code-to-rag/core/outbound"
import { scriptedDecisionModel, scriptedEmbeddingModel, scriptedLanguageModel } from "@code-to-rag/core/testing"
import { Database } from "@code-to-rag/postgres"
import { makeTestDatabaseLayer, resetDatabase, testDatabaseUrl } from "@code-to-rag/postgres/testing"
import { sql } from "drizzle-orm"
import { Effect, Layer, ManagedRuntime, Option } from "effect"
import { randomBytes, randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as nodePath from "node:path"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { card, cleanDecide, defaultDecide, defaultRespond, sampleProject } from "./support/understanding.ts"
import { storeUpload, testAdapters } from "./support/adapters.ts"

const url = testDatabaseUrl()
if (url === undefined && process.env["CI"] !== undefined) throw new Error("TEST_DATABASE_URL is required in CI")

let respond: (request: StructuredRequest<OutputSchema>) => unknown = defaultRespond
let decide: (request: DecisionRequest) => Record<string, number> = defaultDecide
const requests: Array<StructuredRequest<OutputSchema>> = []

const makeLayer = (databaseUrl: string) =>
  Layer.mergeAll(
    testAdapters,
    // Embeddings not configured: no indexing jobs in the queue of these tests.
    scriptedEmbeddingModel({ configured: false }),
    scriptedLanguageModel((request) => {
      requests.push(request)
      return respond(request)
    }),
    scriptedDecisionModel((request) => decide(request))
  ).pipe(Layer.provideMerge(AppConfig.layer), Layer.provideMerge(makeTestDatabaseLayer(databaseUrl)))
type Services = Layer.Success<ReturnType<typeof makeLayer>>

const reviewer = { id: "user-1", name: "Revisore" }

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
    decide = defaultDecide
    requests.length = 0
    await run(resetDatabase)
  })

  const runClaimed = async (): Promise<Job> => {
    const job = await run(JobRepository.use((jobs) => jobs.claim("test-worker"))).then(Option.getOrThrow)
    switch (job.type) {
      case "acquisition":
        await run(Jobs.runJob(Jobs.acquisitionPipeline, job))
        break
      case "analysis":
        await run(Jobs.runJob(Jobs.analysisPipeline, job))
        break
      case "understanding":
        await run(Jobs.runJob(Jobs.understandingPipeline, job))
        break
      case "card":
        await run(Jobs.runJob(Jobs.cardPipeline, job))
    }
    return run(JobRepository.use((jobs) => jobs.get(job.id)))
  }

  /** Acquires, analyzes and understands the sample project; returns the ids of the only card. */
  const understood = async () => {
    const uploadId = UploadId.make(randomUUID())
    await run(storeUpload(uploadId, sampleProject()))
    const summary = await run(Projects.createProject({ name: "Shop", source: { type: "zip", uploadId } }, null))
    const snapshotId: SnapshotId = summary.latestSnapshot!.id
    await runClaimed()
    await runClaimed()
    await run(Knowledge.requestUnderstanding(snapshotId))
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

  it("writes no card for a technical feature until a reviewer asks for one", async () => {
    respond = (request) =>
      request.prompt.id === "feature-map"
        ? {
            features: [
              {
                name: "Orders",
                description: "Create orders.",
                files: ["web/src/orders/service.ts"],
                symbols: ["OrderService.create"]
              },
              {
                name: "Build setup",
                description: "Configuration of the build.",
                files: ["config/app.json"],
                symbols: []
              }
            ]
          }
        : defaultRespond(request)
    decide = (request) =>
      request.prompt.id === "feature-triage"
        ? { user_facing: request.state.includes("Build setup") ? 0.1 : 0.85 }
        : defaultDecide(request)
    const { snapshotId } = await understood()
    const features = async () => (await run(KnowledgeRepository.use((k) => k.featureMap(snapshotId)))).features

    expect((await features()).map((f) => [f.name, f.technical, f.userFacing, f.card !== null])).toEqual([
      ["Orders", false, 0.85, true],
      ["Build setup", true, 0.1, false]
    ])
    const cardPrompts = () =>
      requests.filter((r) => r.prompt.id === "card").map((r) => /^Feature: (.+)$/m.exec(r.input)?.[1])
    expect(cardPrompts()).toEqual(["Orders"])
    const { snapshot } = await run(SnapshotRepository.use((s) => s.get(snapshotId)))
    expect(snapshot).toMatchObject({ featureCount: 2, cardCount: 1 })

    // The reviewer decides it belongs in the documentation: a card job writes and verifies it.
    const buildSetup = (await features()).find((f) => f.name === "Build setup")!
    const job = await run(Knowledge.requestFeatureCard(snapshotId, buildSetup.id))
    expect(job).toMatchObject({
      type: "card",
      payload: { cardId: null, featureId: buildSetup.id, operation: "generate" }
    })
    expect((await features()).find((f) => f.id === buildSetup.id)?.technical).toBe(false)
    expect((await runClaimed()).status).toBe("succeeded")
    expect(cardPrompts()).toEqual(["Orders", "Build setup"])
    const generated = (await features()).find((f) => f.id === buildSetup.id)!
    expect(generated.card?.status).toBe("flagged")
    // Asking again for a feature that has a card is refused.
    const again = await run(Effect.flip(Knowledge.requestFeatureCard(snapshotId, buildSetup.id)))
    expect(again._tag).toBe("InvalidInputError")
  })

  it("records the reviewer's decisions on statements and confirms the rest on approval", async () => {
    const { snapshotId, featureId, cardId } = await understood()
    const card = () => currentCard(snapshotId, featureId)
    expect((await card()).status).toBe("flagged")

    await run(Knowledge.reviewStatement(snapshotId, cardId, "limits.0", "wrong", reviewer))
    await run(Knowledge.reviewStatement(snapshotId, cardId, "behavior.0", "confirmed", reviewer))
    // A decision puts the card in review; deciding again replaces it, null removes it.
    expect(await card()).toMatchObject({ status: "in_review" })
    await run(Knowledge.reviewStatement(snapshotId, cardId, "behavior.0", null, reviewer))
    expect((await card()).statementReviews.map((r) => [r.id, r.verdict, r.reviewer])).toEqual([
      ["limits.0", "wrong", "Revisore"]
    ])
    const unknown = await run(Effect.flip(Knowledge.reviewStatement(snapshotId, cardId, "limits.9", "wrong", reviewer)))
    expect(unknown._tag).toBe("NotFoundError")

    // Approval confirms every statement without a decision and keeps the reviewer's ones.
    await run(Knowledge.setCardStatus(snapshotId, cardId, "approved", reviewer))
    const approved = await card()
    expect(approved.status).toBe("approved")
    expect(Object.fromEntries(approved.statementReviews.map((r) => [r.id, r.verdict]))).toEqual({
      "behavior.0": "confirmed",
      "parameters.0": "confirmed",
      "limits.0": "wrong",
      "errors.0": "confirmed"
    })
    // Marking a statement wrong on an approved card reopens it.
    await run(Knowledge.reviewStatement(snapshotId, cardId, "errors.0", "wrong", reviewer))
    expect((await card()).status).toBe("in_review")
    // A manual edit keeps the decisions of the statements left identical (under their new ids) and drops the others.
    await run(
      Knowledge.editCard(
        snapshotId,
        cardId,
        {
          ...approved.content,
          behavior: [{ text: "Creates an order.", references: approved.content.behavior[0]!.references }],
          parameters: []
        },
        reviewer
      )
    )
    const edited = await card()
    expect(edited.version).toBe(approved.version + 1)
    expect(Object.fromEntries(edited.statementReviews.map((r) => [r.id, r.verdict]))).toEqual({
      "limits.0": "wrong",
      "errors.0": "wrong"
    })
  })

  it("verifies a card on demand and keeps review decisions", async () => {
    const { snapshotId, featureId, cardId } = await understood()
    expect((await currentCard(snapshotId, featureId)).status).toBe("flagged")

    await run(Knowledge.setCardStatus(snapshotId, cardId, "approved", reviewer))
    respond = (request) => (request.prompt.id === "card-missing" ? { missing: [] } : defaultRespond(request))
    decide = cleanDecide
    const job = await run(Knowledge.requestCardOperation(snapshotId, cardId, "verify"))
    // One active job per card: asking again returns the same job.
    expect((await run(Knowledge.requestCardOperation(snapshotId, cardId, "verify"))).id).toBe(job.id)
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
        : request.prompt.id === "card-missing"
          ? { missing: [] }
          : defaultRespond(request)
    decide = cleanDecide

    await run(Knowledge.correctCard(snapshotId, cardId, "The limit is in service.ts, line 5.", reviewer))
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
    await run(Knowledge.requestCardOperation(snapshotId, corrected.id, "regenerate"))
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
    await run(Knowledge.correctCard(snapshotId, cardId, "Mention the 100 pieces limit.", reviewer))
    await runClaimed()

    // Card jobs and understanding exclude each other.
    await run(Knowledge.requestUnderstanding(snapshotId))
    const blocked = await run(Effect.flip(Knowledge.requestCardOperation(snapshotId, cardId, "verify")))
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
    await run(Knowledge.requestUnderstanding(snapshotId))
    await runClaimed()
    const renamed = await run(KnowledgeRepository.use((k) => k.featureMap(snapshotId)))
    expect(renamed.orphanCorrections.map((c) => c.featureName)).toEqual(["Orders"])
  })

  it("edits a card by hand, dropping references to lines that do not exist", async () => {
    const { snapshotId, featureId, cardId } = await understood()
    await run(
      Knowledge.editCard(
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
    await run(Knowledge.correctCard(snapshotId, cardId, "Something to fix.", reviewer))
    // The queued card job is deleted with the project, a running one blocks the deletion.
    const claimed = await run(JobRepository.use((jobs) => jobs.claim("test-worker"))).then(Option.getOrThrow)
    const refused = await run(Effect.flip(Projects.deleteProject(ProjectId.make(projectId))))
    expect(refused._tag).toBe("InvalidInputError")
    await run(JobRepository.use((jobs) => jobs.release(claimed.id)))

    await run(Projects.deleteProject(ProjectId.make(projectId)))
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
