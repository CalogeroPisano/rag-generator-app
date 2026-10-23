import { NotFoundError, ProjectId, ProjectRepository, ProjectSummary } from "@code-to-rag/core"
import { desc, inArray, sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Database, query } from "./client.ts"
import { appendJobEvent } from "./job-repository.ts"
import { jobFromRow, projectFromRow, snapshotFromRow } from "./rows.ts"
import { job, project, snapshot } from "./schema/app.ts"

export const ProjectRepositoryLive = Layer.effect(
  ProjectRepository,
  Effect.gen(function* () {
    const { db } = yield* Database

    /** Loads projects with their latest snapshot and job (DISTINCT ON keeps one row per project). */
    const summaries = Effect.fnUntraced(function* (ids: ReadonlyArray<string> | "all") {
      const projects = yield* query("project.list", () => {
        const base = db.select().from(project)
        return (ids === "all" ? base : base.where(inArray(project.id, [...ids]))).orderBy(desc(project.createdAt))
      })
      if (projects.length === 0) return []
      const projectIds = projects.map((row) => row.id)
      const snapshots = yield* query("project.latestSnapshots", () =>
        db
          .selectDistinctOn([snapshot.projectId])
          .from(snapshot)
          .where(inArray(snapshot.projectId, projectIds))
          .orderBy(snapshot.projectId, desc(snapshot.createdAt))
      )
      const jobs = yield* query("project.latestJobs", () =>
        db
          .selectDistinctOn([job.projectId])
          .from(job)
          .where(inArray(job.projectId, projectIds))
          .orderBy(job.projectId, desc(job.createdAt))
      )
      return yield* Effect.forEach(projects, (row) =>
        Effect.gen(function* () {
          const latestSnapshot = snapshots.find((s) => s.projectId === row.id)
          const latestJob = jobs.find((j) => j.projectId === row.id)
          return new ProjectSummary({
            project: yield* projectFromRow(row),
            latestSnapshot: latestSnapshot === undefined ? null : yield* snapshotFromRow(latestSnapshot),
            latestJob: latestJob === undefined ? null : yield* jobFromRow(latestJob)
          })
        })
      )
    })

    const get = Effect.fnUntraced(function* (id: ProjectId) {
      const [summary] = yield* summaries([id])
      if (summary === undefined) return yield* new NotFoundError({ entity: "project", id })
      return summary
    })

    return ProjectRepository.of({
      createWithAcquisition: Effect.fnUntraced(function* (input) {
        yield* query("project.create", () =>
          db.transaction(async (tx) => {
            await tx.insert(project).values({
              id: input.project.id,
              name: input.project.name,
              sourceType: input.project.sourceType,
              repositoryUrl: input.project.repositoryUrl,
              repositoryRef: input.project.repositoryRef,
              repositoryUsername: input.project.repositoryUsername,
              encryptedToken: input.project.encryptedToken,
              createdBy: input.project.createdBy
            })
            await tx.insert(snapshot).values({
              id: input.snapshotId,
              projectId: input.project.id,
              status: "pending",
              uploadId: input.uploadId
            })
            await tx.insert(job).values({
              id: input.jobId,
              type: "acquisition",
              projectId: input.project.id,
              snapshotId: input.snapshotId,
              status: "queued",
              maxAttempts: input.maxAttempts
            })
            await appendJobEvent(tx, input.jobId, "queued")
          })
        )
        // The project was just inserted in the same connection pool: not finding it is a bug.
        return yield* get(input.project.id).pipe(Effect.catchTag("NotFoundError", Effect.die))
      }),

      list: summaries("all"),

      get,

      getGitSource: Effect.fnUntraced(function* (id) {
        const rows = yield* query("project.gitSource", () =>
          db
            .select({
              url: project.repositoryUrl,
              ref: project.repositoryRef,
              username: project.repositoryUsername,
              encryptedToken: project.encryptedToken
            })
            .from(project)
            .where(sql`${project.id} = ${id} and ${project.sourceType} = 'git'`)
        )
        const row = rows[0]
        if (row === undefined || row.url === null) return yield* new NotFoundError({ entity: "git source", id })
        return { url: row.url, ref: row.ref, username: row.username, encryptedToken: row.encryptedToken }
      })
    })
  })
)
