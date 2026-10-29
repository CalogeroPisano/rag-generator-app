import {
  cancelJob,
  CreateProjectInput,
  createProject,
  Job,
  JobId,
  JobRepository,
  ProjectId,
  ProjectRepository,
  ProjectSummary,
  requestNewVersion,
  Snapshot,
  SnapshotId,
  SnapshotRepository,
  SourceFileContent,
  SourceFileEntry,
  UploadId
} from "@code-to-rag/core"
import { createServerFn } from "@tanstack/react-start"
import { Effect, Schema } from "effect"
import { authMiddleware } from "@/server/middleware"
import { runEffect } from "@/server/run.server"

// Results are encoded to plain objects: schema classes do not cross the network boundary.
const encodeSummary = Schema.encodeSync(ProjectSummary)
const encodeSummaries = Schema.encodeSync(Schema.Array(ProjectSummary))
const encodeJob = Schema.encodeSync(Job)
const encodeEntries = Schema.encodeSync(Schema.Array(SourceFileEntry))
const encodeContent = Schema.encodeSync(SourceFileContent)
const encodeSnapshots = Schema.encodeSync(Schema.Array(Snapshot))

const validate = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
  Schema.toStandardSchemaV1(schema)

export const listProjects = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(() => runEffect(ProjectRepository.use((repository) => repository.list).pipe(Effect.map(encodeSummaries))))

export const getProject = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(validate(Schema.Struct({ projectId: ProjectId })))
  .handler(({ data }) =>
    runEffect(ProjectRepository.use((repository) => repository.get(data.projectId)).pipe(Effect.map(encodeSummary)))
  )

export const createProjectFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(validate(CreateProjectInput))
  .handler(({ data, context }) => runEffect(createProject(data, context.user.id).pipe(Effect.map(encodeSummary))))

/** New version of the code: an uploaded archive (zip projects) or the latest commit of the branch (Git). */
export const startNewVersion = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(validate(Schema.Struct({ projectId: ProjectId, uploadId: Schema.NullOr(UploadId) })))
  .handler(({ data }) => runEffect(requestNewVersion(data.projectId, data.uploadId).pipe(Effect.map(encodeSummary))))

/** Versions of a project, newest first. */
export const listVersions = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(validate(Schema.Struct({ projectId: ProjectId })))
  .handler(({ data }) =>
    runEffect(SnapshotRepository.use((snapshots) => snapshots.list(data.projectId)).pipe(Effect.map(encodeSnapshots)))
  )

export const retryJob = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(validate(Schema.Struct({ jobId: JobId })))
  .handler(({ data }) => runEffect(JobRepository.use((jobs) => jobs.retry(data.jobId)).pipe(Effect.map(encodeJob))))

/** Stops a queued or running job ("Interrompi"); "Riprendi" (retryJob) resumes it from the interrupted phase. */
export const stopJob = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(validate(Schema.Struct({ jobId: JobId })))
  .handler(({ data }) => runEffect(cancelJob(data.jobId).pipe(Effect.map(encodeJob))))

export const listFiles = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(validate(Schema.Struct({ snapshotId: SnapshotId })))
  .handler(({ data }) =>
    runEffect(
      SnapshotRepository.use((snapshots) => snapshots.listFiles(data.snapshotId)).pipe(Effect.map(encodeEntries))
    )
  )

export const getFileContent = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(validate(Schema.Struct({ snapshotId: SnapshotId, path: Schema.String.check(Schema.isMaxLength(4096)) })))
  .handler(({ data }) =>
    runEffect(
      SnapshotRepository.use((snapshots) => snapshots.getFileContent(data.snapshotId, data.path)).pipe(
        Effect.map(encodeContent)
      )
    )
  )
