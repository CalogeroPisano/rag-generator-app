/**
 * Test questions of the RAG chat. A `questions` job writes a few questions per
 * card (with the expected answer); reviewers add and edit their own. An
 * `evaluation` job (test run) asks every question to the chat as a user would:
 * it measures whether the expected card is retrieved, then lets the model
 * judge the answer against that card.
 */
import {
  ANSWER_JUDGE,
  AnswerJudgeOutput,
  answerJudgeInstructions,
  EmbeddingModel,
  LanguageModel,
  renderAnswerJudge,
  renderCardText,
  renderTestQuestions,
  TEST_QUESTIONS,
  TestQuestionsOutput,
  testQuestionsInstructions
} from "@code-to-rag/ai"
import { Effect } from "effect"
import { randomUUID } from "node:crypto"
import { AppConfig } from "../config.ts"
import {
  EvaluationJobPayload,
  type Job,
  JobId,
  type ProjectId,
  type SnapshotId,
  type TestQuestion,
  type TestQuestionInput,
  type TestResult
} from "../domain.ts"
import { InvalidInputError, NotFoundError, PhaseError } from "../errors.ts"
import type { PhaseContext, Pipeline } from "../pipeline.ts"
import {
  EvaluationRepository,
  IndexRepository,
  JobRepository,
  KnowledgeRepository,
  type Reviewer,
  SnapshotRepository
} from "../ports.ts"
import { chunks, provenance, skipInvalid, toPhaseError } from "../understanding/shared.ts"
import { generateAnswer, prepareAnswer } from "./chat.ts"

const CARD_BATCH_SIZE = 4

type Progress = PhaseContext["progress"]

// ---------------------------------------------------------------------------
// Question generation

const generateQuestions = Effect.fn("evaluation.generateQuestions")(
  function* (job: Job, progress: Progress) {
    const config = yield* AppConfig
    const knowledge = yield* KnowledgeRepository
    const evaluation = yield* EvaluationRepository
    const model = yield* LanguageModel
    const context = { phase: "generate", jobId: job.id, snapshotId: job.snapshotId }

    const { features } = yield* knowledge.featureMap(job.snapshotId)
    const existing = yield* evaluation.questions(job.snapshotId, job.projectId)
    // Resumable: features that already have generated questions are skipped.
    const covered = new Set(existing.filter((q) => q.origin === "generated").map((q) => q.featureId))
    const eligible = features.filter((f) => f.card !== null && f.card.status !== "excluded")
    const pending = eligible.filter((f) => !covered.has(f.id))

    let completed = eligible.length - pending.length
    let skipped = 0
    const report = () =>
      progress({
        completed,
        total: eligible.length,
        message: `${completed} di ${eligible.length} schede con domande${skipped > 0 ? ` (${skipped} saltate)` : ""}`
      })
    yield* report()
    for (const batch of chunks(pending, CARD_BATCH_SIZE)) {
      yield* Effect.forEach(
        batch,
        (feature) =>
          Effect.gen(function* () {
            const card = yield* knowledge.getCard(job.snapshotId, feature.card?.id ?? "")
            const answer = yield* skipInvalid(
              model.generateObject({
                prompt: TEST_QUESTIONS,
                context,
                instructions: testQuestionsInstructions({
                  language: config.rag.questionsLanguage,
                  count: config.rag.questionsPerCard
                }),
                input: renderTestQuestions({ card: renderCardText({ featureName: feature.name, card: card.content }) }),
                schema: TestQuestionsOutput
              }),
              () => skipped++
            )
            completed++
            const questions = (answer?.questions ?? [])
              .map((q) => ({ question: q.question.trim(), expectedAnswer: q.expectedAnswer.trim() }))
              .filter((q) => q.question.length >= 3)
              .slice(0, config.rag.questionsPerCard)
            if (questions.length === 0) return
            yield* evaluation.addQuestions(
              job.projectId,
              questions.map((q) => ({
                featureId: feature.id,
                featureName: feature.name,
                question: q.question,
                expectedAnswer: q.expectedAnswer === "" ? null : q.expectedAnswer,
                origin: "generated" as const,
                authorName: null,
                provenance: provenance(model, TEST_QUESTIONS)
              }))
            )
          }),
        { concurrency: "unbounded", discard: true }
      )
      yield* report()
    }
  },
  (effect) => effect.pipe(Effect.mapError(toPhaseError("generate")))
)

export const questionsPipeline: Pipeline<EvaluationRepository | KnowledgeRepository | LanguageModel | AppConfig> = {
  type: "questions",
  phases: [{ name: "generate", run: ({ job, progress }) => generateQuestions(job, progress) }],
  onFailed: () => Effect.void
}

// ---------------------------------------------------------------------------
// Test run

/** Questions a run asks: attached to a feature whose card is in scope. */
const runQuestions = Effect.fnUntraced(function* (job: Job, approvedOnly: boolean) {
  const knowledge = yield* KnowledgeRepository
  const evaluation = yield* EvaluationRepository
  const { features } = yield* knowledge.featureMap(job.snapshotId)
  const inScope = new Map(
    features.flatMap((f) =>
      f.card !== null && (approvedOnly ? f.card.status === "approved" : f.card.status !== "excluded")
        ? [[f.id, { feature: f, cardId: f.card.id }] as const]
        : []
    )
  )
  const questions = (yield* evaluation.questions(job.snapshotId, job.projectId)).filter(
    (q) => q.featureId !== null && inScope.has(q.featureId)
  )
  return { questions, inScope }
})

const payloadOf = (job: Job) => {
  const payload = job.payload
  return payload !== null && "approvedOnly" in payload ? payload : { approvedOnly: false }
}

const prepareRun = Effect.fn("evaluation.prepareRun")(
  function* (job: Job) {
    const config = yield* AppConfig
    const evaluation = yield* EvaluationRepository
    const model = yield* LanguageModel
    const embeddings = yield* EmbeddingModel
    if (model.modelId === undefined || embeddings.modelId === undefined) {
      return yield* new PhaseError({
        phase: "prepare",
        message: "Modello IA o di embedding non configurato (AI_MODEL, EMBEDDING_MODEL)",
        retryable: false
      })
    }
    const { approvedOnly } = payloadOf(job)
    const { questions } = yield* runQuestions(job, approvedOnly)
    yield* evaluation.startRun({
      id: job.id,
      snapshotId: job.snapshotId,
      model: model.modelId,
      embeddingModel: embeddings.modelId,
      topK: config.rag.topCards,
      approvedOnly,
      questions: questions.length
    })
  },
  (effect) => effect.pipe(Effect.mapError(toPhaseError("prepare")))
)

/** Asks one question to the chat (no history) and judges the answer. */
const evaluateQuestion = Effect.fnUntraced(function* (
  job: Job,
  question: TestQuestion,
  expected: { readonly featureId: string; readonly featureName: string; readonly cardId: string },
  approvedOnly: boolean
) {
  const knowledge = yield* KnowledgeRepository
  const index = yield* IndexRepository
  const model = yield* LanguageModel
  const context = { phase: "answer", jobId: job.id, snapshotId: job.snapshotId }

  const prepared = yield* prepareAnswer(job.snapshotId, question.question, {
    approvedOnly,
    history: [],
    carryOver: [],
    context
  })
  const retrievedCards = yield* index.cards(
    job.snapshotId,
    prepared.ranked.map((card) => card.cardId)
  )
  const position = prepared.ranked.findIndex((card) => card.cardId === expected.cardId)
  const answer = yield* generateAnswer(prepared, context)
  const card = yield* knowledge.getCard(job.snapshotId, expected.cardId)
  const judged = yield* skipInvalid(
    model.generateObject({
      prompt: ANSWER_JUDGE,
      context: { ...context, phase: "judge" },
      instructions: answerJudgeInstructions,
      input: renderAnswerJudge({
        question: question.question,
        card: renderCardText({ featureName: expected.featureName, card: card.content }),
        expectedAnswer: question.expectedAnswer,
        answer: answer.text
      }),
      schema: AnswerJudgeOutput
    }),
    () => undefined
  )
  return {
    questionId: question.id,
    question: question.question,
    expectedFeatureId: expected.featureId,
    expectedFeatureName: expected.featureName,
    retrieved: retrievedCards.map((c) => ({ featureId: c.featureId, featureName: c.featureName })),
    rank: position < 0 ? null : position + 1,
    answer: answer.text,
    citedFeatureIds: answer.citations.flatMap((n) => {
      const source = prepared.sources[n - 1]
      return source === undefined ? [] : [source.featureId]
    }),
    verdict: judged?.verdict ?? null,
    note: judged?.note.trim() ?? null
  } satisfies TestResult
})

const answerQuestions = Effect.fn("evaluation.answerQuestions")(
  function* (job: Job, progress: Progress) {
    const evaluation = yield* EvaluationRepository
    const { approvedOnly } = payloadOf(job)
    const { questions, inScope } = yield* runQuestions(job, approvedOnly)
    const done = new Set((yield* evaluation.getRun(job.id)).results.map((r) => r.questionId))
    // Resumable: questions already answered by this run are skipped.
    const pending = questions.filter((q) => !done.has(q.id))
    let completed = questions.length - pending.length
    const report = () =>
      progress({
        completed,
        total: questions.length,
        message: `${completed} di ${questions.length} domande valutate`
      })
    yield* report()
    for (const question of pending) {
      const scope = inScope.get(question.featureId ?? "")
      if (scope === undefined) continue
      const result = yield* evaluateQuestion(
        job,
        question,
        { featureId: scope.feature.id, featureName: scope.feature.name, cardId: scope.cardId },
        approvedOnly
      )
      yield* evaluation.saveResult(job.id, result)
      completed++
      yield* report()
    }
  },
  (effect) => effect.pipe(Effect.mapError(toPhaseError("answer")))
)

/** Totals of a run from its results. */
export const runTotals = (results: ReadonlyArray<TestResult>, topK: number) => {
  const count = (verdict: TestResult["verdict"]) => results.filter((r) => r.verdict === verdict).length
  const ranks = results.map((r) => (r.rank !== null && r.rank <= topK ? r.rank : null))
  return {
    retrievalHits: ranks.filter((rank) => rank !== null).length,
    firstHits: ranks.filter((rank) => rank === 1).length,
    mrr:
      results.length === 0
        ? 0
        : ranks.reduce<number>((sum, rank) => sum + (rank === null ? 0 : 1 / rank), 0) / results.length,
    correct: count("correct"),
    partial: count("partial"),
    incorrect: count("incorrect"),
    noAnswer: count("no_answer"),
    unjudged: count(null)
  }
}

const finalizeRun = Effect.fn("evaluation.finalizeRun")(
  function* (job: Job) {
    const evaluation = yield* EvaluationRepository
    const { run, results } = yield* evaluation.getRun(job.id)
    yield* evaluation.finishRun(job.id, "ready", runTotals(results, run.topK))
  },
  (effect) => effect.pipe(Effect.mapError(toPhaseError("finalize")))
)

export const evaluationPipeline: Pipeline<
  AppConfig | EmbeddingModel | EvaluationRepository | IndexRepository | KnowledgeRepository | LanguageModel
> = {
  type: "evaluation",
  phases: [
    { name: "prepare", run: ({ job }) => prepareRun(job) },
    { name: "answer", run: ({ job, progress }) => answerQuestions(job, progress) },
    { name: "finalize", run: ({ job }) => finalizeRun(job) }
  ],
  onFailed: (job) =>
    EvaluationRepository.use((evaluation) => evaluation.finishRun(job.id, "failed", null)).pipe(Effect.ignore)
}

// ---------------------------------------------------------------------------
// Use cases

/** The snapshot must have its cards, and no understanding may be replacing them. */
const readySnapshot = Effect.fnUntraced(function* (snapshotId: SnapshotId) {
  const snapshots = yield* SnapshotRepository
  const jobs = yield* JobRepository
  const { snapshot } = yield* snapshots.get(snapshotId)
  if (snapshot.understandingStatus !== "ready") {
    return yield* new InvalidInputError({ message: "Le schede del progetto non sono ancora pronte" })
  }
  const active = yield* jobs.active(snapshot.projectId)
  if (active.some((job) => job.type === "understanding")) {
    return yield* new InvalidInputError({ message: "La comprensione con IA è in corso: riprova al termine" })
  }
  return snapshot
})

/** Queues the generation of test questions for the cards that have none yet. */
export const requestQuestionGeneration = Effect.fn("requestQuestionGeneration")(function* (snapshotId: SnapshotId) {
  const config = yield* AppConfig
  const jobs = yield* JobRepository
  const snapshot = yield* readySnapshot(snapshotId)
  return yield* jobs.enqueue({
    id: JobId.make(randomUUID()),
    type: "questions",
    projectId: snapshot.projectId,
    snapshotId,
    maxAttempts: config.jobMaxAttempts
  })
})

/** Queues a test run of the chat over the project's test questions. */
export const requestEvaluation = Effect.fn("requestEvaluation")(function* (
  snapshotId: SnapshotId,
  options: { readonly approvedOnly: boolean }
) {
  const config = yield* AppConfig
  const jobs = yield* JobRepository
  const embeddings = yield* EmbeddingModel
  if (embeddings.modelId === undefined) {
    return yield* new InvalidInputError({ message: "Modello di embedding non configurato (EMBEDDING_MODEL)" })
  }
  const snapshot = yield* readySnapshot(snapshotId)
  return yield* jobs.enqueue({
    id: JobId.make(randomUUID()),
    type: "evaluation",
    projectId: snapshot.projectId,
    snapshotId,
    maxAttempts: config.jobMaxAttempts,
    payload: { approvedOnly: options.approvedOnly } satisfies EvaluationJobPayload
  })
})

/** The feature a reviewer's question is about, in the snapshot's current map. */
const featureOf = Effect.fnUntraced(function* (snapshotId: SnapshotId, featureId: string) {
  const knowledge = yield* KnowledgeRepository
  const { features } = yield* knowledge.featureMap(snapshotId)
  const feature = features.find((f) => f.id === featureId)
  if (feature === undefined) return yield* new NotFoundError({ entity: "feature", id: featureId })
  return feature
})

const projectOf = Effect.fnUntraced(function* (snapshotId: SnapshotId) {
  const snapshots = yield* SnapshotRepository
  const { snapshot } = yield* snapshots.get(snapshotId)
  return snapshot.projectId
})

export const addTestQuestion = Effect.fn("addTestQuestion")(function* (
  snapshotId: SnapshotId,
  input: TestQuestionInput,
  author: Reviewer
) {
  const evaluation = yield* EvaluationRepository
  const projectId = yield* projectOf(snapshotId)
  const feature = yield* featureOf(snapshotId, input.featureId)
  yield* evaluation.addQuestions(projectId, [
    {
      featureId: feature.id,
      featureName: feature.name,
      question: input.question,
      expectedAnswer: input.expectedAnswer === null || input.expectedAnswer === "" ? null : input.expectedAnswer,
      origin: "manual",
      authorName: author.name,
      provenance: null
    }
  ])
})

export const updateTestQuestion = Effect.fn("updateTestQuestion")(function* (
  snapshotId: SnapshotId,
  questionId: string,
  input: TestQuestionInput
) {
  const evaluation = yield* EvaluationRepository
  const projectId = yield* projectOf(snapshotId)
  const feature = yield* featureOf(snapshotId, input.featureId)
  yield* evaluation.updateQuestion(projectId, questionId, {
    featureId: feature.id,
    featureName: feature.name,
    question: input.question,
    expectedAnswer: input.expectedAnswer === null || input.expectedAnswer === "" ? null : input.expectedAnswer
  })
})

export const deleteTestQuestion = Effect.fn("deleteTestQuestion")(function* (
  snapshotId: SnapshotId,
  questionId: string
) {
  const evaluation = yield* EvaluationRepository
  const projectId: ProjectId = yield* projectOf(snapshotId)
  yield* evaluation.deleteQuestion(projectId, questionId)
})
