import {
  type CardContent,
  type OutputSchema,
  scriptedEmbeddingModel,
  scriptedLanguageModel,
  type StructuredRequest,
  type TextRequest
} from "@code-to-rag/ai"
import {
  acquisitionPipeline,
  addTestQuestion,
  analysisPipeline,
  AppConfig,
  askQuestion,
  cardPipeline,
  type ChatEvent,
  ChatRepository,
  CodeAnalyzer,
  CARD_CHUNK,
  createProject,
  deleteProject,
  editCard,
  EvaluationRepository,
  evaluationPipeline,
  IndexRepository,
  indexingPipeline,
  type Job,
  JobRepository,
  KnowledgeRepository,
  questionsPipeline,
  requestEvaluation,
  requestIndexing,
  requestQuestionGeneration,
  requestUnderstanding,
  retrieveCards,
  runJob,
  SecretBox,
  setCardStatus,
  type SnapshotId,
  understandingPipeline,
  UploadId,
  uploadPath,
  UserId
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
import { card as ordersCard, defaultRespond, sampleProject } from "./support/understanding.ts"

const url = testDatabaseUrl()
if (url === undefined && process.env["CI"] !== undefined) throw new Error("TEST_DATABASE_URL is required in CI")

const pricesCard: CardContent = {
  title: "Prices",
  summary: "Prices are shown with two decimals.",
  behavior: [
    {
      text: "Formats every price with two decimal digits.",
      references: [{ path: "web/src/lib/money.ts", startLine: 1, endLine: 1 }]
    }
  ],
  configuration: [],
  parameters: [],
  limits: [],
  validationRules: [],
  errors: []
}

/** Two features (orders and prices), a card for each, questions and verdicts. */
const respond = (request: StructuredRequest<OutputSchema>): unknown => {
  switch (request.prompt.id) {
    case "feature-map":
      return {
        features: [
          {
            name: "Orders",
            description: "Create orders.",
            files: ["web/src/orders/service.ts"],
            symbols: ["OrderService.create"]
          },
          { name: "Prices", description: "Format prices.", files: ["web/src/lib/money.ts"], symbols: ["formatPrice"] }
        ]
      }
    case "card":
      return /^Feature: Prices$/m.test(request.input) ? pricesCard : ordersCard
    case "card-verify":
      return { statements: [], missing: [] }
    case "test-questions":
      return /^Prices \(feature/m.test(request.input.replace(/^Card:\n/, ""))
        ? { questions: [{ question: "How many decimals do prices have?", expectedAnswer: "Two." }] }
        : {
            questions: [
              { question: "What is the maximum order quantity?", expectedAnswer: "100 pieces." },
              { question: "  ", expectedAnswer: "Dropped: empty question." }
            ]
          }
    case "answer-judge":
      return request.input.includes("[1]")
        ? { verdict: "correct", note: "Matches the card." }
        : { verdict: "no_answer", note: "No answer." }
    default:
      return defaultRespond(request)
  }
}

/** The chat answers citing the first source, unless asked to say it does not know. */
let respondText: (request: TextRequest) => string = () => "From the documentation [1]."
const textRequests: Array<TextRequest> = []

const makeLayer = (databaseUrl: string) =>
  Layer.mergeAll(
    SecretBox.layer,
    CodeAnalyzer.layer,
    scriptedEmbeddingModel(),
    scriptedLanguageModel(respond, {
      respondText: (request) => {
        textRequests.push(request)
        return respondText(request)
      }
    })
  ).pipe(Layer.provideMerge(AppConfig.layer), Layer.provideMerge(makeTestDatabaseLayer(databaseUrl)))
type Services = Layer.Success<ReturnType<typeof makeLayer>>

const user = { id: "user-1", name: "Revisore" }

describe.skipIf(url === undefined)("RAG index, chat and tests (PostgreSQL + pgvector)", () => {
  let runtime: ManagedRuntime.ManagedRuntime<Services, unknown>
  let dataDir: string
  const run = <A, E>(effect: Effect.Effect<A, E, Services>) => runtime.runPromise(effect)

  beforeAll(async () => {
    dataDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "code-to-rag-rag-"))
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
    respondText = () => "From the documentation [1]."
    textRequests.length = 0
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
        break
      case "indexing":
        await run(runJob(indexingPipeline, job))
        break
      case "questions":
        await run(runJob(questionsPipeline, job))
        break
      case "evaluation":
        await run(runJob(evaluationPipeline, job))
    }
    return run(JobRepository.use((jobs) => jobs.get(job.id)))
  }

  /** Acquires, analyzes, understands and indexes the sample project. */
  const indexed = async () => {
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
    // The understanding queued the indexing of its cards.
    const indexing = await runClaimed()
    expect(indexing).toMatchObject({ type: "indexing", status: "succeeded" })
    const map = await run(KnowledgeRepository.use((k) => k.featureMap(snapshotId)))
    const byName = new Map(map.features.map((f) => [f.name, f]))
    return {
      projectId: summary.project.id,
      snapshotId,
      orders: byName.get("Orders")!,
      prices: byName.get("Prices")!
    }
  }

  const status = (snapshotId: SnapshotId) =>
    run(
      IndexRepository.use((index) =>
        index.status(snapshotId, { model: "scripted-embedding-model", formatVersion: CARD_CHUNK.version })
      )
    )

  it("indexes the cards and finds them by meaning and by exact words", async () => {
    const { snapshotId, orders, prices } = await indexed()
    expect(await status(snapshotId)).toMatchObject({ indexableCards: 2, indexedCards: 2, approvedCards: 0 })
    const chunks = await run(
      Database.use(({ db }) =>
        Effect.promise(() =>
          db.execute<{ section: string; dimensions: number }>(
            sql`select section, dimensions from rag.chunk where snapshot_id = ${snapshotId} order by id`
          )
        )
      )
    )
    // Orders: overview, behavior, parameters, errors (the limit lost its only reference but is kept); Prices: 2.
    expect(chunks.rows.map((r) => r.section).sort()).toEqual(
      ["behavior", "behavior", "errors", "limits", "overview", "overview", "parameters"].sort()
    )
    expect(new Set(chunks.rows.map((r) => r.dimensions))).toEqual(new Set([64]))

    const retrieve = (question: string, approvedOnly = false) =>
      run(
        retrieveCards(snapshotId, question, {
          approvedOnly,
          limit: 5,
          candidates: 20,
          context: { phase: "test" }
        })
      )
    expect((await retrieve("prices decimal digits"))[0]?.cardId).toBe(prices.card!.id)
    // An exact message only appears in the orders card.
    expect((await retrieve("Massimo pezzi"))[0]?.cardId).toBe(orders.card!.id)

    // Excluded cards leave the results; "approved only" keeps approved cards only.
    await run(setCardStatus(snapshotId, prices.card!.id, "excluded", user))
    expect((await retrieve("prices decimal digits")).map((r) => r.cardId)).not.toContain(prices.card!.id)
    expect(await retrieve("orders", true)).toEqual([])
    await run(setCardStatus(snapshotId, orders.card!.id, "approved", user))
    expect((await retrieve("orders", true)).map((r) => r.cardId)).toEqual([orders.card!.id])
    expect(await status(snapshotId)).toMatchObject({ indexableCards: 1, indexedCards: 1, approvedCards: 1 })
  })

  it("re-indexes an edited card and ignores its outdated chunks meanwhile", async () => {
    const { snapshotId, prices } = await indexed()
    const current = await run(KnowledgeRepository.use((k) => k.getCard(snapshotId, prices.card!.id)))
    await run(
      editCard(snapshotId, prices.card!.id, { ...current.content, summary: "Totals are rounded to cents." }, user)
    )
    // The edit queued an indexing job; until it runs the old chunks are not searchable.
    expect(await status(snapshotId)).toMatchObject({ indexedCards: 1 })
    const job = await run(requestIndexing(snapshotId))
    // A queued job absorbs further requests.
    expect(Option.getOrThrow(job).status).toBe("queued")
    expect((await runClaimed()).type).toBe("indexing")
    expect(await status(snapshotId)).toMatchObject({ indexedCards: 2 })
    const hits = await run(
      retrieveCards(snapshotId, "rounded cents", {
        approvedOnly: false,
        limit: 1,
        candidates: 20,
        context: { phase: "t" }
      })
    )
    expect(hits[0]?.cardId).toBe(prices.card!.id)
  })

  it("answers in a stored conversation, with sources, citations and follow-up context", async () => {
    const { projectId, prices } = await indexed()
    const ask = async (conversationId: string | null, question: string) => {
      const events: Array<ChatEvent> = []
      await run(
        askQuestion(
          { projectId, userId: UserId.make(user.id), conversationId, question, approvedOnly: false },
          (event) => events.push(event)
        )
      )
      return events
    }
    // The chat needs a real user (conversations reference it).
    await run(
      Database.use(({ db }) =>
        Effect.promise(() =>
          db.execute(
            sql`insert into "user" (id, name, email, email_verified, created_at, updated_at) values (${user.id}, ${user.name}, 'r@example.com', true, now(), now())`
          )
        )
      )
    )
    const first = await ask(null, "How are prices shown?")
    const conversation = first.find((e) => e.type === "conversation")
    expect(conversation?.type === "conversation" && conversation.conversation.title).toBe("How are prices shown?")
    const done = first.at(-1)
    expect(done?.type).toBe("done")
    const conversationId = conversation?.type === "conversation" ? conversation.conversation.id : ""

    // Follow-up: the history is sent and the card cited before stays among the sources.
    respondText = () => "Yes [1]."
    await ask(conversationId, "And for totals?")
    const followUp = textRequests.at(-1)!
    expect(followUp.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"])
    expect(followUp.messages[0]?.content).toBe("How are prices shown?")

    const view = await run(ChatRepository.use((chat) => chat.getConversation(conversationId, UserId.make(user.id))))
    expect(view.messages.map((m) => [m.role, m.status])).toEqual([
      ["user", "complete"],
      ["assistant", "complete"],
      ["user", "complete"],
      ["assistant", "complete"]
    ])
    const answer = view.messages[1]!
    expect(answer.citations).toEqual([1])
    expect(answer.sources[0]).toMatchObject({ featureId: prices.id, title: "Prices" })
    // Other users cannot read it.
    await expect(
      run(ChatRepository.use((chat) => chat.getConversation(conversationId, UserId.make("someone-else"))))
    ).rejects.toThrow()
  })

  it("generates test questions, runs the tests and keeps questions across a new feature map", async () => {
    const { projectId, snapshotId, orders, prices } = await indexed()
    await run(requestQuestionGeneration(snapshotId))
    expect((await runClaimed()).status).toBe("succeeded")
    await run(
      addTestQuestion(
        snapshotId,
        { featureId: orders.id, question: "Can I order 500 pieces?", expectedAnswer: null },
        user
      )
    )
    const questions = await run(EvaluationRepository.use((e) => e.questions(snapshotId, projectId)))
    // Generated questions of different cards are written concurrently: compare without order.
    expect(questions.map((q) => [q.featureId, q.origin, q.question]).sort()).toEqual(
      [
        [orders.id, "generated", "What is the maximum order quantity?"],
        [prices.id, "generated", "How many decimals do prices have?"],
        [orders.id, "manual", "Can I order 500 pieces?"]
      ].sort()
    )
    // Generating again skips the cards that already have generated questions.
    await run(requestQuestionGeneration(snapshotId))
    expect((await runClaimed()).status).toBe("succeeded")
    expect(await run(EvaluationRepository.use((e) => e.questions(snapshotId, projectId)))).toHaveLength(3)

    // The chat answers citing source 1, which is the right card only when retrieval ranks it first.
    const job = await run(requestEvaluation(snapshotId, { approvedOnly: false }))
    expect((await runClaimed()).status).toBe("succeeded")
    const { run: testRun, results } = await run(EvaluationRepository.use((e) => e.getRun(job.id)))
    expect(testRun).toMatchObject({ status: "ready", questions: 3, topK: 5, approvedOnly: false })
    expect(results).toHaveLength(3)
    expect(results.every((r) => r.rank !== null && r.verdict === "correct")).toBe(true)
    expect(testRun.retrievalHits).toBe(3)
    expect(testRun.correct).toBe(3)
    // Runs are listed per project, with the revision of the version they tested.
    const runs = await run(EvaluationRepository.use((e) => e.runs(snapshotId)))
    expect(runs.map((r) => [r.id, r.snapshotId])).toEqual([[job.id, snapshotId]])
    expect(runs[0]?.revision).toBe(testRun.revision)
    expect(testRun.revision).toMatch(/^[0-9a-f]{64}$/)

    // A new understanding re-attaches the questions by feature name.
    await run(requestUnderstanding(snapshotId))
    expect((await runClaimed()).type).toBe("understanding")
    const after = await run(KnowledgeRepository.use((k) => k.featureMap(snapshotId)))
    const reattached = await run(EvaluationRepository.use((e) => e.questions(snapshotId, projectId)))
    expect(new Set(reattached.map((q) => q.featureId))).toEqual(new Set(after.features.map((f) => f.id)))

    // Deleting the project removes questions, runs and chunks.
    await run(deleteProject(projectId))
    const left = await run(
      Database.use(({ db }) =>
        Effect.promise(() =>
          db.execute<{ n: number }>(
            sql`select (select count(*) from rag.test_question) + (select count(*) from rag.test_run) + (select count(*) from rag.chunk) as n`
          )
        )
      )
    )
    expect(Number(left.rows[0]?.n)).toBe(0)
  })
})
