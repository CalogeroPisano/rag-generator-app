import { Layer } from "effect"
import { AnalysisRepositoryLive } from "./analysis-repository.ts"
import { Database } from "./client.ts"
import { JobRepositoryLive } from "./job-repository.ts"
import { ProjectRepositoryLive } from "./project-repository.ts"
import { SnapshotRepositoryLive } from "./snapshot-repository.ts"

export * from "./analysis-repository.ts"
export * from "./client.ts"
export * from "./job-events.ts"
export * from "./job-repository.ts"
export * from "./project-repository.ts"
export * from "./snapshot-repository.ts"
export * as schema from "./schema/index.ts"

/** Every repository, on top of an existing `Database`. */
export const RepositoriesLive = Layer.mergeAll(
  ProjectRepositoryLive,
  SnapshotRepositoryLive,
  JobRepositoryLive,
  AnalysisRepositoryLive
)

/** Repositories plus the `Database` service itself (pool from `DATABASE_URL`). */
export const DatabaseLive = RepositoriesLive.pipe(Layer.provideMerge(Database.layer))
