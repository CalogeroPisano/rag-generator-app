/**
 * Read-only use cases: what the pages show. They go through the ports like the
 * commands, so that the inbound adapters never reach the outbound ports.
 */
import { Effect } from "effect"
import type { ProjectId, SnapshotId, UserId } from "../domain/model.ts"
import { EmbeddingModel, LanguageModel } from "../ports/outbound/models.ts"
import {
  AnalysisRepository,
  ChatRepository,
  EvaluationRepository,
  IndexRepository,
  KnowledgeRepository,
  ProjectRepository,
  SnapshotRepository,
  type SymbolQuery,
  UnderstandingRepository
} from "../ports/outbound/repositories.ts"
import { CARD_CHUNK } from "./rag/chunks.ts"

// ── Projects and code ──

export const listProjects = ProjectRepository.use((projects) => projects.list)

export const getProject = (projectId: ProjectId) => ProjectRepository.use((projects) => projects.get(projectId))

/** Versions of the code of a project, newest first. */
export const listVersions = (projectId: ProjectId) => SnapshotRepository.use((snapshots) => snapshots.list(projectId))

export const listFiles = (snapshotId: SnapshotId) =>
  SnapshotRepository.use((snapshots) => snapshots.listFiles(snapshotId))

/** Masked content of a file (the only form stored). */
export const getFileContent = (snapshotId: SnapshotId, path: string) =>
  SnapshotRepository.use((snapshots) => snapshots.getFileContent(snapshotId, path))

// ── Static analysis ──

export const listSymbols = (snapshotId: SnapshotId, query: SymbolQuery) =>
  AnalysisRepository.use((analysis) => analysis.listSymbols(snapshotId, query))

export const getFileAnalysis = (snapshotId: SnapshotId, path: string) =>
  AnalysisRepository.use((analysis) => analysis.fileAnalysis(snapshotId, path))

export const getDependencyOverview = (snapshotId: SnapshotId) =>
  AnalysisRepository.use((analysis) => analysis.overview(snapshotId))

// ── Knowledge ──

export const getFeatureMap = (snapshotId: SnapshotId) =>
  KnowledgeRepository.use((knowledge) => knowledge.featureMap(snapshotId))

export const getCard = (snapshotId: SnapshotId, cardId: string) =>
  KnowledgeRepository.use((knowledge) => knowledge.getCard(snapshotId, cardId))

export const getFileSummary = (snapshotId: SnapshotId, path: string) =>
  KnowledgeRepository.use((knowledge) => knowledge.fileSummary(snapshotId, path))

export const getModelCallStats = (snapshotId: SnapshotId) =>
  UnderstandingRepository.use((understanding) => understanding.modelCallStats(snapshotId))

/** Models the application can use (ids only: URLs and keys are details of the adapters). */
export const getModelStatus = Effect.gen(function* () {
  const chat = yield* LanguageModel
  const embedding = yield* EmbeddingModel
  return { chatModel: chat.modelId ?? null, embeddingModel: embedding.modelId ?? null }
})

/** State of the embedding index for the configured embedding model. */
export const getIndexStatus = Effect.fn("getIndexStatus")(function* (snapshotId: SnapshotId) {
  const model = (yield* EmbeddingModel).modelId
  return yield* (yield* IndexRepository).status(
    snapshotId,
    model === undefined ? undefined : { model, formatVersion: CARD_CHUNK.version }
  )
})

// ── Chat conversations (always filtered by the session user) ──

export const listConversations = (projectId: ProjectId, userId: UserId) =>
  ChatRepository.use((chat) => chat.conversations(projectId, userId))

export const getConversation = (conversationId: string, userId: UserId) =>
  ChatRepository.use((chat) => chat.getConversation(conversationId, userId))

export const deleteConversation = (conversationId: string, userId: UserId) =>
  ChatRepository.use((chat) => chat.deleteConversation(conversationId, userId))

// ── Test questions and runs ──

/** Test questions of the features of a version (they belong to the project). */
export const listTestQuestions = Effect.fn("listTestQuestions")(function* (snapshotId: SnapshotId) {
  const { snapshot } = yield* (yield* SnapshotRepository).get(snapshotId)
  return yield* (yield* EvaluationRepository).questions(snapshotId, snapshot.projectId)
})

export const listTestRuns = (snapshotId: SnapshotId) =>
  EvaluationRepository.use((evaluation) => evaluation.runs(snapshotId))

export const getTestRun = (runId: string) => EvaluationRepository.use((evaluation) => evaluation.getRun(runId))
