import {
  CreateProjectInput,
  Job,
  JobId,
  Jobs,
  ProjectId,
  Projects,
  ProjectSummary,
  Snapshot,
  SnapshotId,
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
  .handler(() => runEffect(Projects.listProjects.pipe(Effect.map(encodeSummaries))))

export const getProject = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(validate(Schema.Struct({ projectId: ProjectId })))
  .handler(({ data }) => runEffect(Projects.getProject(data.projectId).pipe(Effect.map(encodeSummary))))

export const createProjectFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(validate(CreateProjectInput))
  .handler(({ data, context }) =>
    runEffect(Projects.createProject(data, context.user.id).pipe(Effect.map(encodeSummary)))
  )

/** New version of the code: an uploaded archive (zip projects) or the latest commit of the branch (Git). */
export const startNewVersion = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(validate(Schema.Struct({ projectId: ProjectId, uploadId: Schema.NullOr(UploadId) })))
  .handler(({ data }) =>
    runEffect(Projects.requestNewVersion(data.projectId, data.uploadId).pipe(Effect.map(encodeSummary)))
  )

/** Versions of a project, newest first. */
export const listVersions = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(validate(Schema.Struct({ projectId: ProjectId })))
  .handler(({ data }) => runEffect(Projects.listVersions(data.projectId).pipe(Effect.map(encodeSnapshots))))

export const retryJob = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(validate(Schema.Struct({ jobId: JobId })))
  .handler(({ data }) => runEffect(Jobs.retryJob(data.jobId).pipe(Effect.map(encodeJob))))

/** Stops a queued or running job ("Interrompi"); "Riprendi" (retryJob) resumes it from the interrupted phase. */
export const stopJob = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(validate(Schema.Struct({ jobId: JobId })))
  .handler(({ data }) => runEffect(Jobs.cancelJob(data.jobId).pipe(Effect.map(encodeJob))))

export const listFiles = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(validate(Schema.Struct({ snapshotId: SnapshotId })))
  .handler(({ data }) => runEffect(Projects.listFiles(data.snapshotId).pipe(Effect.map(encodeEntries))))

export const getFileContent = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(validate(Schema.Struct({ snapshotId: SnapshotId, path: Schema.String.check(Schema.isMaxLength(4096)) })))
  .handler(({ data }) => runEffect(Projects.getFileContent(data.snapshotId, data.path).pipe(Effect.map(encodeContent))))
