import { type CardContent } from "../src/domain/card.ts"
import { AiError, type TextRequest } from "../src/ports/outbound/models.ts"
import { hashEmbedding, scriptedEmbeddingModel, scriptedLanguageModel } from "../src/testing.ts"
import { citedSources } from "../src/application/prompts/chat.ts"
import { ConfigProvider, Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { AppConfig } from "../src/application/config.ts"
import {
  ChatConversation,
  ChatMessage,
  type ChatSource,
  Project,
  ProjectId,
  ProjectSummary,
  Snapshot,
  SnapshotId,
  type TestResult,
  UserId
} from "../src/domain/model.ts"
import {
  ChatRepository,
  type ContextCard,
  IndexRepository,
  type NewChatMessage,
  ProjectRepository
} from "../src/ports/outbound/repositories.ts"
import { askQuestion, type ChatEvent, prepareAnswer } from "../src/application/rag/chat.ts"
import { cardChunks } from "../src/application/rag/chunks.ts"
import { runTotals } from "../src/application/rag/evaluation.ts"
import { fuseRankings, searchTerms } from "../src/application/rag/retrieval.ts"

const content = (title: string, extra: Partial<CardContent> = {}): CardContent => ({
  title,
  summary: `${title} for end users.`,
  behavior: [
    { text: "Uploads are stored after validation.", references: [{ path: "a.ts", startLine: 1, endLine: 2 }] }
  ],
  configuration: [],
  parameters: [
    {
      name: "maxSize",
      description: "Largest accepted file.",
      type: "number",
      required: false,
      defaultValue: "10 MB",
      references: []
    }
  ],
  limits: [],
  validationRules: [],
  errors: [{ condition: "The file is too large", message: "File troppo grande", references: [] }],
  ...extra
})

describe("cardChunks", () => {
  it("makes an overview chunk and one chunk per non-empty section, prefixed with the title", () => {
    const chunks = cardChunks("File upload", content("Upload files"))
    expect(chunks.map((c) => c.section)).toEqual(["overview", "behavior", "parameters", "errors"])
    expect(chunks[0]?.text).toBe("Upload files (feature: File upload)\nUpload files for end users.")
    expect(chunks[2]?.text).toBe(
      "Upload files: Parameters\n- maxSize (number, optional, default 10 MB): Largest accepted file."
    )
    expect(chunks[3]?.text).toContain('The file is too large (message: "File troppo grande")')
    // References are not embedded.
    expect(chunks.some((c) => c.text.includes("a.ts"))).toBe(false)
  })
})

describe("searchTerms", () => {
  it("keeps distinct words of three or more characters, lower case", () => {
    expect(searchTerms("Qual è il limite di maxSize? E il LIMITE per l'upload?")).toEqual([
      "qual",
      "limite",
      "maxsize",
      "per",
      "upload"
    ])
  })
})

describe("fuseRankings", () => {
  it("sums reciprocal ranks per card across lists, counting each card once per list", () => {
    const ranked = fuseRankings([
      [
        { cardId: "a", section: "overview" },
        { cardId: "b", section: "limits" },
        { cardId: "a", section: "limits" }
      ],
      [
        { cardId: "b", section: "parameters" },
        { cardId: "c", section: "errors" }
      ]
    ])
    expect(ranked.map((r) => r.cardId)).toEqual(["b", "a", "c"])
    expect(ranked[0]?.score).toBeCloseTo(1 / 62 + 1 / 61)
    expect(ranked[1]?.score).toBeCloseTo(1 / 61)
  })
})

describe("runTotals", () => {
  const result = (rank: number | null, verdict: TestResult["verdict"]): TestResult => ({
    questionId: "q",
    question: "?",
    expectedFeatureId: "f",
    expectedFeatureName: "F",
    retrieved: [],
    rank,
    answer: "",
    citedFeatureIds: [],
    verdict,
    note: null
  })
  it("computes hits within top k, first hits, MRR and verdict counts", () => {
    const totals = runTotals(
      [result(1, "correct"), result(2, "partial"), result(null, "no_answer"), result(6, null)],
      5
    )
    expect(totals).toEqual({
      retrievalHits: 2,
      firstHits: 1,
      mrr: (1 + 1 / 2) / 4,
      correct: 1,
      partial: 1,
      incorrect: 0,
      noAnswer: 1,
      unjudged: 1
    })
  })
})

// ---------------------------------------------------------------------------
// Chat with in-memory repositories

const projectId = ProjectId.make("00000000-0000-4000-8000-000000000001")
const snapshotId = SnapshotId.make("00000000-0000-4000-8000-000000000002")
const userId = UserId.make("user-1")

const card = (n: number, status: ChatSource["status"] = "generated"): ContextCard => ({
  cardId: `card-${n}`,
  featureId: `feature-${n}`,
  featureName: `Feature ${n}`,
  title: `Card ${n}`,
  status,
  content: content(`Card ${n}`)
})

const snapshot = new Snapshot({
  id: snapshotId,
  projectId,
  status: "ready",
  commitSha: null,
  contentHash: "hash",
  includedFiles: 1,
  excludedFiles: 0,
  maskedSecrets: 0,
  analysisStatus: "ready",
  analyzedAt: new Date(),
  symbolCount: 0,
  dependencyCount: 0,
  understandingStatus: "ready",
  understoodAt: new Date(),
  featureCount: 3,
  cardCount: 3,
  baseSnapshotId: null,
  changes: null,
  createdAt: new Date()
})

const summary = new ProjectSummary({
  project: new Project({
    id: projectId,
    name: "Shop",
    sourceType: "zip",
    repositoryUrl: null,
    repositoryRef: null,
    hasCredentials: false,
    createdBy: null,
    createdAt: new Date()
  }),
  currentSnapshot: snapshot,
  latestSnapshot: snapshot,
  latestJob: null
})

const makeLayer = (options: {
  readonly cards: ReadonlyArray<ContextCard>
  readonly respondText: (request: TextRequest) => string | AiError
  readonly stored: Array<NewChatMessage>
  readonly env?: Record<string, string>
}) => {
  const index = Layer.succeed(
    IndexRepository,
    IndexRepository.of({
      cardsToIndex: () => Effect.succeed([]),
      saveChunks: () => Effect.void,
      clear: () => Effect.void,
      status: () => Effect.die("unused"),
      // Vector search returns every card in order; the full-text one finds nothing.
      search: () =>
        Effect.succeed({ vector: options.cards.map((c) => ({ cardId: c.cardId, section: "overview" })), text: [] }),
      cards: (_, ids) => Effect.succeed(ids.flatMap((id) => options.cards.filter((c) => c.cardId === id)))
    })
  )
  const conversation = new ChatConversation({
    id: "00000000-0000-4000-8000-000000000003",
    projectId,
    title: "t",
    createdAt: new Date(),
    updatedAt: new Date()
  })
  const chat = Layer.succeed(
    ChatRepository,
    ChatRepository.of({
      conversations: () => Effect.succeed([conversation]),
      createConversation: (input) =>
        Effect.succeed(
          new ChatConversation({
            id: conversation.id,
            projectId,
            title: input.title,
            createdAt: conversation.createdAt,
            updatedAt: conversation.updatedAt
          })
        ),
      getConversation: () => Effect.succeed({ conversation, messages: [] }),
      addMessage: (_, message) =>
        Effect.sync(() => {
          options.stored.push(message)
          return new ChatMessage({ ...message, id: `m${options.stored.length}`, createdAt: new Date() })
        }),
      deleteConversation: () => Effect.void
    })
  )
  const projects = Layer.succeed(
    ProjectRepository,
    ProjectRepository.of({
      createWithAcquisition: () => Effect.die("unused"),
      createSnapshot: () => Effect.die("unused"),
      setCurrentSnapshot: () => Effect.die("unused"),
      list: Effect.die("unused"),
      get: () => Effect.succeed(summary),
      getGitSource: () => Effect.die("unused"),
      delete: () => Effect.die("unused")
    })
  )
  const config = AppConfig.layer.pipe(
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: options.env ?? {} })))
  )
  return Layer.mergeAll(
    index,
    chat,
    projects,
    config,
    scriptedEmbeddingModel(),
    scriptedLanguageModel(() => ({}), { respondText: options.respondText })
  )
}

describe("prepareAnswer", () => {
  it("numbers the retrieved cards, adds the cards cited before and leaves out excluded ones", async () => {
    const stored: Array<NewChatMessage> = []
    const cards = [card(1), card(2, "excluded"), card(3, "approved")]
    const prepared = await Effect.runPromise(
      prepareAnswer(snapshotId, "How large can an upload be?", {
        approvedOnly: false,
        history: [{ question: "Earlier?", answer: "Earlier answer [1]." }],
        carryOver: ["card-3"],
        context: { phase: "test" }
      }).pipe(Effect.provide(makeLayer({ cards: cards.slice(0, 2), respondText: () => "", stored })))
    )
    expect(prepared.sources.map((s) => s.cardId)).toEqual(["card-1"])
    expect(prepared.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"])
    expect(prepared.messages[2]?.content).toContain("[1] Card 1 (feature: Feature 1)")
    expect(prepared.messages[2]?.content).toContain("Question: How large can an upload be?")

    const approved = await Effect.runPromise(
      prepareAnswer(snapshotId, "upload", {
        approvedOnly: true,
        history: [],
        carryOver: [],
        context: { phase: "test" }
      }).pipe(Effect.provide(makeLayer({ cards, respondText: () => "", stored })))
    )
    expect(approved.sources.map((s) => s.cardId)).toEqual(["card-3"])
  })

  it("keeps the prompt within the context window", async () => {
    const stored: Array<NewChatMessage> = []
    // About 100 characters (33 tokens) per step.
    const long = (n: number, steps: number): ContextCard => ({
      ...card(n),
      content: content(`Card ${n}`, {
        behavior: Array.from({ length: steps }, (_, i) => ({ text: `Step ${i} ${"x".repeat(90)}`, references: [] }))
      })
    })
    const prepare = (cards: ReadonlyArray<ContextCard>) =>
      Effect.runPromise(
        prepareAnswer(snapshotId, "upload", {
          approvedOnly: false,
          history: [],
          carryOver: [],
          context: { phase: "t" }
        }).pipe(Effect.provide(makeLayer({ cards, respondText: () => "", stored })))
      )
    const tokens = (prepared: { readonly messages: ReadonlyArray<{ readonly content: string }> }) =>
      prepared.messages.reduce((sum, m) => sum + m.content.length, 0) / 3

    // The scripted model has 16k tokens, 1024 for the answer: one 8k-token card fits, the second does not.
    const two = await prepare([long(1, 250), long(2, 250), card(3)])
    expect(two.sources.map((s) => s.cardId)).toEqual(["card-1"])
    // A card larger than the whole budget is shortened rather than dropped.
    const huge = await prepare([long(1, 1000)])
    expect(huge.sources.map((s) => s.cardId)).toEqual(["card-1"])
    expect(tokens(huge)).toBeLessThan(16_384 - 1024)
  })
})

describe("askQuestion", () => {
  const run = (layer: ReturnType<typeof makeLayer>) => {
    const events: Array<ChatEvent> = []
    return Effect.runPromise(
      askQuestion(
        { projectId, userId, conversationId: null, question: "  Max upload size?  ", approvedOnly: false },
        (event) => events.push(event)
      ).pipe(Effect.provide(layer), Effect.as(events))
    )
  }

  it("streams the answer and stores question and answer with sources and citations", async () => {
    const stored: Array<NewChatMessage> = []
    const events = await run(
      makeLayer({ cards: [card(1), card(2)], respondText: () => "The limit is 10 MB [2]. See also [7].", stored })
    )
    expect(events[0]?.type).toBe("conversation")
    expect(events[1]).toMatchObject({ type: "sources", sources: [{ cardId: "card-1" }, { cardId: "card-2" }] })
    expect(events.at(-1)?.type).toBe("done")
    const streamed = events.flatMap((e) => (e.type === "delta" ? [e.text] : [])).join("")
    expect(streamed).toBe("The limit is 10 MB [2]. See also [7].")
    expect(stored.map((m) => [m.role, m.content, m.status])).toEqual([
      ["user", "Max upload size?", "complete"],
      ["assistant", "The limit is 10 MB [2]. See also [7].", "complete"]
    ])
    // [7] does not exist: only valid source numbers are kept.
    expect(stored[1]?.citations).toEqual([2])
    expect(stored[1]?.sources.map((s) => s.cardId)).toEqual(["card-1", "card-2"])
  })

  it("keeps the question and a failed answer when the model fails", async () => {
    const stored: Array<NewChatMessage> = []
    const events = await run(
      makeLayer({
        cards: [card(1)],
        respondText: () =>
          new AiError({ kind: "timeout", message: "Il modello non ha risposto in tempo", retryable: true }),
        stored
      })
    )
    expect(events.at(-1)).toEqual({ type: "error", message: "Il modello non ha risposto in tempo" })
    expect(stored.map((m) => [m.role, m.status])).toEqual([
      ["user", "complete"],
      ["assistant", "failed"]
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
