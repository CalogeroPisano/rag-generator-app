import { Layer } from "effect"
import { AnalysisRepositoryLive } from "./analysis-repository.ts"
import { ChatRepositoryLive } from "./chat-repository.ts"
import { Database } from "./client.ts"
import { EvaluationRepositoryLive } from "./evaluation-repository.ts"
import { ExportRepositoryLive } from "./export-repository.ts"
import { IndexRepositoryLive } from "./index-repository.ts"
import { JobRepositoryLive } from "./job-repository.ts"
import { KnowledgeRepositoryLive } from "./knowledge-repository.ts"
import { ProjectRepositoryLive } from "./project-repository.ts"
import { SnapshotRepositoryLive } from "./snapshot-repository.ts"
import { ModelCallRecorderLive, UnderstandingRepositoryLive } from "./understanding-repository.ts"

export * from "./analysis-repository.ts"
export * from "./chat-repository.ts"
export * from "./client.ts"
export * from "./evaluation-repository.ts"
export * from "./export-repository.ts"
export * from "./index-repository.ts"
export * from "./job-events.ts"
export * from "./job-repository.ts"
export * from "./knowledge-repository.ts"
export * from "./project-repository.ts"
export * from "./secret-box.ts"
export * from "./snapshot-repository.ts"
export * from "./understanding-repository.ts"
export * as schema from "./schema/index.ts"

/** Every repository, on top of an existing `Database`. */
import { SettingsRepositoryLive, UserRepositoryLive } from "./settings-repository.ts"

export const RepositoriesLive = Layer.mergeAll(
  ProjectRepositoryLive,
  SnapshotRepositoryLive,
  JobRepositoryLive,
  AnalysisRepositoryLive,
  UnderstandingRepositoryLive,
  KnowledgeRepositoryLive,
  ModelCallRecorderLive,
  IndexRepositoryLive,
  EvaluationRepositoryLive,
  ChatRepositoryLive,
  ExportRepositoryLive,
  SettingsRepositoryLive,
  UserRepositoryLive
)

/** Repositories plus the `Database` service itself (pool from `DATABASE_URL`). */
export const DatabaseLive = RepositoriesLive.pipe(Layer.provideMerge(Database.layer))
