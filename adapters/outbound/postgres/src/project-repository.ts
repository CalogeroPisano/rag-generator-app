import { NotFoundError, ProjectId, ProjectRepository, ProjectSummary, UploadId } from "@code-to-rag/core/outbound"
import { desc, eq, inArray, sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Database, query } from "./client.ts"
import { appendJobEvent } from "./job-repository.ts"
import { jobFromRow, projectFromRow, snapshotFromRow } from "./rows.ts"
import { job, project, snapshot, sourceBlob, sourceFile } from "./schema/app.ts"

export const ProjectRepositoryLive = Layer.effect(
  ProjectRepository,
  Effect.gen(function* () {
    const { db } = yield* Database

    /** Loads projects with their current and latest snapshot and latest job (DISTINCT ON keeps one row per project). */
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
      const currentIds = projects.flatMap((row) =>
        row.currentSnapshotId === null || snapshots.some((s) => s.id === row.currentSnapshotId)
          ? []
          : [row.currentSnapshotId]
      )
      const current =
        currentIds.length === 0
          ? []
          : yield* query("project.currentSnapshots", () =>
              db.select().from(snapshot).where(inArray(snapshot.id, currentIds))
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
          const currentSnapshot = [...snapshots, ...current].find((s) => s.id === row.currentSnapshotId)
          const latestJob = jobs.find((j) => j.projectId === row.id)
          return new ProjectSummary({
            project: yield* projectFromRow(row),
            currentSnapshot: currentSnapshot === undefined ? null : yield* snapshotFromRow(currentSnapshot),
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
            // The first version is the current one from the start.
            await tx
              .update(project)
              .set({ currentSnapshotId: input.snapshotId })
              .where(eq(project.id, input.project.id))
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

      createSnapshot: Effect.fnUntraced(function* (input) {
        yield* query("project.createSnapshot", () =>
          db.transaction(async (tx) => {
            await tx.insert(snapshot).values({
              id: input.snapshotId,
              projectId: input.projectId,
              status: "pending",
              uploadId: input.uploadId,
              baseSnapshotId: input.baseSnapshotId
            })
            await tx.insert(job).values({
              id: input.jobId,
              type: "acquisition",
              projectId: input.projectId,
              snapshotId: input.snapshotId,
              status: "queued",
              maxAttempts: input.maxAttempts
            })
            await appendJobEvent(tx, input.jobId, "queued")
          })
        )
        return yield* get(input.projectId).pipe(Effect.catchTag("NotFoundError", Effect.die))
      }),

      setCurrentSnapshot: (id, snapshotId) =>
        query("project.setCurrentSnapshot", () =>
          db.update(project).set({ currentSnapshotId: snapshotId }).where(eq(project.id, id))
        ).pipe(Effect.asVoid),

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
      }),

      delete: (id) =>
        query("project.delete", () =>
          db.transaction(async (tx) => {
            const uploads = await tx
              .select({ uploadId: snapshot.uploadId })
              .from(snapshot)
              .where(sql`${snapshot.projectId} = ${id} and ${snapshot.uploadId} is not null`)
            // Blobs are shared across projects (deduplicated by hash): remember this project's, delete the orphans.
            await tx.execute(sql`
              create temporary table deleted_hashes on commit drop as
              select distinct f.content_hash as hash
              from ${sourceFile} f join ${snapshot} s on s.id = f.snapshot_id
              where s.project_id = ${id} and f.content_hash is not null`)
            // Snapshots, files, symbols, jobs and events cascade; the model call log keeps its rows (set null).
            await tx.delete(project).where(sql`${project.id} = ${id}`)
            await tx.execute(sql`
              delete from ${sourceBlob} b
              using deleted_hashes d
              where b.hash = d.hash
                and not exists (select 1 from ${sourceFile} f where f.content_hash = b.hash)`)
            return uploads.flatMap((row) => (row.uploadId === null ? [] : [UploadId.make(row.uploadId)]))
          })
        ).pipe(Effect.map((uploadIds) => ({ uploadIds })))
    })
  })
)
