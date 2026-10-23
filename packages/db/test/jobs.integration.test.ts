import type { PreparedFile } from "@code-to-rag/analysis"
import {
  JobId,
  JobRepository,
  ProjectId,
  ProjectRepository,
  SnapshotId,
  SnapshotRepository,
  UploadId
} from "@code-to-rag/core"
import { Database } from "@code-to-rag/db"
import { makeTestDatabaseLayer, resetDatabase, testDatabaseUrl } from "@code-to-rag/db/testing"
import { sql } from "drizzle-orm"
import { Effect, Layer, ManagedRuntime, Option } from "effect"
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

const url = testDatabaseUrl()
if (url === undefined && process.env["CI"] !== undefined) throw new Error("TEST_DATABASE_URL is required in CI")

type Services = Layer.Success<ReturnType<typeof makeTestDatabaseLayer>>

describe.skipIf(url === undefined)("repositories (PostgreSQL)", () => {
  let runtime: ManagedRuntime.ManagedRuntime<Services, unknown>
  const run = <A, E>(effect: Effect.Effect<A, E, Services>) => runtime.runPromise(effect)

  beforeAll(async () => {
    runtime = ManagedRuntime.make(makeTestDatabaseLayer(url!))
    await run(Effect.void)
  })
  afterAll(() => runtime.dispose())
  beforeEach(() => run(resetDatabase))

  const createProject = (maxAttempts = 3) =>
    ProjectRepository.use((projects) =>
      projects.createWithAcquisition({
        project: {
          id: ProjectId.make(randomUUID()),
          name: "Demo",
          sourceType: "zip",
          repositoryUrl: null,
          repositoryRef: null,
          repositoryUsername: null,
          encryptedToken: null,
          createdBy: null
        },
        snapshotId: SnapshotId.make(randomUUID()),
        uploadId: UploadId.make(randomUUID()),
        jobId: JobId.make(randomUUID()),
        maxAttempts
      })
    )

  const claim = (workerId = "test-worker") => JobRepository.use((jobs) => jobs.claim(workerId))

  it("creates project, snapshot and queued job atomically", async () => {
    const summary = await run(createProject())
    expect(summary.latestSnapshot?.status).toBe("pending")
    expect(summary.latestJob?.status).toBe("queued")
    const events = await run(JobRepository.use((jobs) => jobs.eventsAfter(summary.latestJob!.id, 0)))
    expect(events.map((event) => event.kind)).toEqual(["queued"])
    expect(await run(ProjectRepository.use((projects) => projects.list))).toHaveLength(1)
  })

  it("hands each job to exactly one worker under concurrency", async () => {
    await run(Effect.all([createProject(), createProject(), createProject()]))
    const claims = await run(
      Effect.all(
        Array.from({ length: 8 }, (_, i) => claim(`worker-${i}`)),
        { concurrency: "unbounded" }
      )
    )
    const claimed = claims.flatMap((result) => (Option.isSome(result) ? [result.value] : []))
    expect(claimed).toHaveLength(3)
    expect(new Set(claimed.map((job) => job.id)).size).toBe(3)
    expect(claimed.every((job) => job.status === "running" && job.attempts === 1)).toBe(true)
    expect(Option.isNone(await run(claim()))).toBe(true)
  })

  it("records completed phases idempotently", async () => {
    await run(createProject())
    const job = Option.getOrThrow(await run(claim()))
    await run(
      JobRepository.use((jobs) =>
        Effect.gen(function* () {
          yield* jobs.startPhase(job.id, "fetch")
          yield* jobs.completePhase(job.id, "fetch")
          yield* jobs.completePhase(job.id, "fetch")
        })
      )
    )
    const updated = await run(JobRepository.use((jobs) => jobs.get(job.id)))
    expect(updated.completedPhases).toEqual(["fetch"])
    expect(updated.currentPhase).toBe("fetch")
  })

  it("delays retries and gives released jobs back without consuming an attempt", async () => {
    await run(createProject())
    const job = Option.getOrThrow(await run(claim()))
    await run(JobRepository.use((jobs) => jobs.scheduleRetry(job.id, "boom", new Date(Date.now() + 60_000))))
    expect(Option.isNone(await run(claim()))).toBe(true)

    await run(createProject())
    const second = Option.getOrThrow(await run(claim()))
    await run(JobRepository.use((jobs) => jobs.release(second.id)))
    const reclaimed = Option.getOrThrow(await run(claim()))
    expect(reclaimed.id).toBe(second.id)
    expect(reclaimed.attempts).toBe(1)
  })

  it("requeues abandoned jobs and fails those without attempts left", async () => {
    await run(createProject(1))
    await run(createProject(3))
    const first = Option.getOrThrow(await run(claim()))
    const second = Option.getOrThrow(await run(claim()))
    const requeued = await run(JobRepository.use((jobs) => jobs.requeueStale(new Date(Date.now() + 1000))))
    expect(requeued).toBe(2)
    const statuses = await run(JobRepository.use((jobs) => Effect.all([jobs.get(first.id), jobs.get(second.id)])))
    expect(statuses.map((job) => [job.maxAttempts, job.status])).toEqual(
      expect.arrayContaining([
        [1, "failed"],
        [3, "queued"]
      ])
    )
  })

  it("retries a failed job manually from the failed phase", async () => {
    await run(createProject())
    const job = Option.getOrThrow(await run(claim()))
    await run(JobRepository.use((jobs) => jobs.completePhase(job.id, "fetch")))
    await run(JobRepository.use((jobs) => jobs.fail(job.id, "ingest: broken")))
    const retried = await run(JobRepository.use((jobs) => jobs.retry(job.id)))
    expect(retried.status).toBe("queued")
    expect(retried.attempts).toBe(0)
    expect(retried.completedPhases).toEqual(["fetch"])
  })

  it("stores files with deduplicated contents", async () => {
    const first = await run(createProject())
    const second = await run(createProject())
    const file = (path: string, content: string): PreparedFile => ({
      path,
      language: "typescript",
      size: content.length,
      isDirectory: false,
      excluded: undefined,
      content,
      contentHash: `hash-${content}`,
      lineCount: 1,
      encoding: "utf-8",
      secrets: [{ rule: "assigned-secret", line: 1 }]
    })
    const excluded: PreparedFile = {
      ...file("node_modules", ""),
      isDirectory: true,
      excluded: "dependency",
      content: undefined,
      contentHash: undefined,
      secrets: []
    }

    await run(
      SnapshotRepository.use((snapshots) =>
        Effect.gen(function* () {
          yield* snapshots.insertFiles(first.latestSnapshot!.id, [file("a.ts", "same"), excluded])
          yield* snapshots.insertFiles(second.latestSnapshot!.id, [file("b.ts", "same")])
        })
      )
    )
    const blobs = await run(
      Database.use(({ db }) =>
        Effect.promise(() => db.execute<{ count: number }>(sql`select count(*)::int as count from source_blob`))
      )
    )
    expect(blobs.rows[0]?.count).toBe(1)

    const entries = await run(SnapshotRepository.use((snapshots) => snapshots.listFiles(first.latestSnapshot!.id)))
    expect(entries.map((entry) => [entry.path, entry.excludedReason, entry.secretCount])).toEqual([
      ["a.ts", null, 1],
      ["node_modules", "dependency", 0]
    ])
    const content = await run(
      SnapshotRepository.use((snapshots) => snapshots.getFileContent(first.latestSnapshot!.id, "a.ts"))
    )
    expect(content.content).toBe("same")

    await run(SnapshotRepository.use((snapshots) => snapshots.clearFiles(first.latestSnapshot!.id)))
    expect(await run(SnapshotRepository.use((snapshots) => snapshots.listFiles(first.latestSnapshot!.id)))).toEqual([])
  })
})
