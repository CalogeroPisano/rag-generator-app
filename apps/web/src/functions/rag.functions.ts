import { AiConfig } from "@code-to-rag/ai"
import {
  addTestQuestion,
  CARD_CHUNK,
  ChatConversation,
  ChatConversationView,
  ChatRepository,
  deleteTestQuestion,
  EvaluationRepository,
  IndexRepository,
  IndexStatus,
  Job,
  JobRepository,
  ProjectId,
  rebuildIndex,
  requestEvaluation,
  requestIndexing,
  requestQuestionGeneration,
  SnapshotId,
  SnapshotRepository,
  TestQuestion,
  TestQuestionInput,
  TestRun,
  TestRunView,
  updateTestQuestion
} from "@code-to-rag/core"
import { createServerFn } from "@tanstack/react-start"
import { Effect, Option, Schema } from "effect"
import { authMiddleware } from "@/server/middleware"
import { runEffect } from "@/server/run.server"

const encodeJob = Schema.encodeSync(Job)
const encodeIndexStatus = Schema.encodeSync(IndexStatus)
const encodeConversations = Schema.encodeSync(Schema.Array(ChatConversation))
const encodeConversation = Schema.encodeSync(ChatConversationView)
const encodeQuestions = Schema.encodeSync(Schema.Array(TestQuestion))
const encodeRuns = Schema.encodeSync(Schema.Array(TestRun))
const encodeRun = Schema.encodeSync(TestRunView)

const validate = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
  Schema.toStandardSchemaV1(schema)

const Uuid = Schema.String.check(Schema.isUUID())

const encodeOptionalJob = (job: Option.Option<Job>) => (Option.isSome(job) ? encodeJob(job.value) : null)

/** Which models the chat can use (ids only: URLs and keys are server details). */
export const getRagStatus = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(() =>
    runEffect(
      AiConfig.use((config) =>
        Effect.succeed({ chatModel: config.model ?? null, embeddingModel: config.embedding.model ?? null })
      )
    )
  )

export const getIndexStatus = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(validate(Schema.Struct({ snapshotId: SnapshotId })))
  .handler(({ data }) =>
    runEffect(
      Effect.gen(function* () {
        const config = yield* AiConfig
        const index = yield* IndexRepository
        const model = config.embedding.model
        const status = yield* index.status(
          data.snapshotId,
          model === undefined ? undefined : { model, formatVersion: CARD_CHUNK.version }
        )
        return encodeIndexStatus(status)
      })
    )
  )

/** Brings the index in line with the cards; `rebuild` deletes it first. */
export const startIndexing = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(validate(Schema.Struct({ snapshotId: SnapshotId, rebuild: Schema.Boolean })))
  .handler(({ data }) =>
    runEffect(
      (data.rebuild ? rebuildIndex(data.snapshotId) : requestIndexing(data.snapshotId)).pipe(
        Effect.map(encodeOptionalJob)
      )
    )
  )

// ── Chat conversations (the exchange itself is streamed by POST /api/chat) ──

export const listConversations = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(validate(Schema.Struct({ projectId: ProjectId })))
  .handler(({ data, context }) =>
    runEffect(
      ChatRepository.use((chat) => chat.conversations(data.projectId, context.user.id)).pipe(
        Effect.map(encodeConversations)
      )
    )
  )

export const getConversation = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(validate(Schema.Struct({ conversationId: Uuid })))
  .handler(({ data, context }) =>
    runEffect(
      ChatRepository.use((chat) => chat.getConversation(data.conversationId, context.user.id)).pipe(
        Effect.map(encodeConversation)
      )
    )
  )

export const deleteConversation = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(validate(Schema.Struct({ conversationId: Uuid })))
  .handler(({ data, context }) =>
    runEffect(ChatRepository.use((chat) => chat.deleteConversation(data.conversationId, context.user.id)))
  )

// ── Test questions and runs ──

export const listTestQuestions = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(validate(Schema.Struct({ snapshotId: SnapshotId })))
  .handler(({ data }) =>
    runEffect(
      Effect.gen(function* () {
        const { snapshot } = yield* SnapshotRepository.use((snapshots) => snapshots.get(data.snapshotId))
        const evaluation = yield* EvaluationRepository
        return encodeQuestions(yield* evaluation.questions(data.snapshotId, snapshot.projectId))
      })
    )
  )

const reviewer = (user: { readonly id: string; readonly name: string }) => ({ id: user.id, name: user.name })

export const createTestQuestion = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(validate(Schema.Struct({ snapshotId: SnapshotId, input: TestQuestionInput })))
  .handler(({ data, context }) => runEffect(addTestQuestion(data.snapshotId, data.input, reviewer(context.user))))

export const saveTestQuestion = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(validate(Schema.Struct({ snapshotId: SnapshotId, questionId: Uuid, input: TestQuestionInput })))
  .handler(({ data }) => runEffect(updateTestQuestion(data.snapshotId, data.questionId, data.input)))

export const removeTestQuestion = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(validate(Schema.Struct({ snapshotId: SnapshotId, questionId: Uuid })))
  .handler(({ data }) => runEffect(deleteTestQuestion(data.snapshotId, data.questionId)))

export const startQuestionGeneration = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(validate(Schema.Struct({ snapshotId: SnapshotId })))
  .handler(({ data }) => runEffect(requestQuestionGeneration(data.snapshotId).pipe(Effect.map(encodeJob))))

export const startTestRun = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(validate(Schema.Struct({ snapshotId: SnapshotId, approvedOnly: Schema.Boolean })))
  .handler(({ data }) =>
    runEffect(requestEvaluation(data.snapshotId, { approvedOnly: data.approvedOnly }).pipe(Effect.map(encodeJob)))
  )

export const listTestRuns = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(validate(Schema.Struct({ snapshotId: SnapshotId })))
  .handler(({ data }) =>
    runEffect(EvaluationRepository.use((evaluation) => evaluation.runs(data.snapshotId)).pipe(Effect.map(encodeRuns)))
  )

export const getTestRun = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(validate(Schema.Struct({ runId: Uuid })))
  .handler(({ data }) =>
    runEffect(EvaluationRepository.use((evaluation) => evaluation.getRun(data.runId)).pipe(Effect.map(encodeRun)))
  )

/** Indexing, question generation and test run jobs queued or running for a project (with their progress). */
export const listRagJobs = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(validate(Schema.Struct({ projectId: ProjectId })))
  .handler(({ data }) =>
    runEffect(
      JobRepository.use((jobs) => jobs.active(data.projectId)).pipe(
        Effect.map((jobs) =>
          jobs
            .filter((job) => job.type === "indexing" || job.type === "questions" || job.type === "evaluation")
            .map((job) => encodeJob(job))
        )
      )
    )
  )
