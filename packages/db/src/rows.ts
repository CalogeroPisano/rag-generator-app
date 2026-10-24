import {
  CardView,
  Correction,
  DatabaseError,
  FeatureMap,
  FileSummaryView,
  ModelCallStats,
  DependencyOverview,
  FileAnalysisView,
  Job,
  JobEvent,
  Project,
  Snapshot,
  SourceFileContent,
  SourceFileEntry,
  SymbolPage
} from "@code-to-rag/core"
import { Effect, Schema } from "effect"
import type { job, jobEvent, project, snapshot } from "./schema/app.ts"

/**
 * Rows are validated with the domain schemas when they leave the database:
 * a row that does not match (e.g. an unknown status written by a newer
 * version) surfaces as a `DatabaseError` instead of flowing into the domain.
 */
const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, operation: string) => {
  const decodeUnknown = Schema.decodeUnknownEffect(schema)
  return (input: unknown): Effect.Effect<S["Type"], DatabaseError> =>
    decodeUnknown(input).pipe(
      Effect.mapError((cause) => new DatabaseError({ operation: `decode ${operation}`, cause }))
    )
}

export const decodeProject = decode(Project, "project")
export const decodeSnapshot = decode(Snapshot, "snapshot")
export const decodeJob = decode(Job, "job")
export const decodeJobEvent = decode(JobEvent, "job_event")
export const decodeFileEntries = decode(Schema.Array(SourceFileEntry), "source_file")
export const decodeFileContent = decode(SourceFileContent, "source_file content")
export const decodeSymbolPage = decode(SymbolPage, "symbol")
export const decodeFileAnalysis = decode(FileAnalysisView, "file analysis")
export const decodeOverview = decode(DependencyOverview, "dependency overview")
export const decodeFeatureMap = decode(FeatureMap, "rag feature map")
export const decodeCard = decode(CardView, "rag card")
export const decodeCorrection = decode(Correction, "rag correction")
export const decodeFileSummary = decode(FileSummaryView, "rag file summary")
export const decodeModelCallStats = decode(ModelCallStats, "model_call stats")

export const projectFromRow = (row: typeof project.$inferSelect) =>
  decodeProject({
    id: row.id,
    name: row.name,
    sourceType: row.sourceType,
    repositoryUrl: row.repositoryUrl,
    repositoryRef: row.repositoryRef,
    hasCredentials: row.encryptedToken !== null,
    createdBy: row.createdBy,
    createdAt: row.createdAt
  })

export const snapshotFromRow = (row: typeof snapshot.$inferSelect) =>
  decodeSnapshot({
    id: row.id,
    projectId: row.projectId,
    status: row.status,
    commitSha: row.commitSha,
    contentHash: row.contentHash,
    includedFiles: row.includedFiles,
    excludedFiles: row.excludedFiles,
    maskedSecrets: row.maskedSecrets,
    analysisStatus: row.analysisStatus,
    analyzedAt: row.analyzedAt,
    symbolCount: row.symbolCount,
    dependencyCount: row.dependencyCount,
    understandingStatus: row.understandingStatus,
    understoodAt: row.understoodAt,
    featureCount: row.featureCount,
    cardCount: row.cardCount,
    createdAt: row.createdAt
  })

export const jobFromRow = (row: typeof job.$inferSelect) =>
  decodeJob({
    id: row.id,
    type: row.type,
    projectId: row.projectId,
    snapshotId: row.snapshotId,
    status: row.status,
    currentPhase: row.currentPhase,
    completedPhases: row.completedPhases,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    lastError: row.lastError,
    progress: row.progress,
    payload: row.payload ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    finishedAt: row.finishedAt
  })

export const jobEventFromRow = (row: typeof jobEvent.$inferSelect) =>
  decodeJobEvent({
    id: row.id,
    jobId: row.jobId,
    kind: row.kind,
    phase: row.phase,
    message: row.message,
    progress: row.progress,
    createdAt: row.createdAt
  })
