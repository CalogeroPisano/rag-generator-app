import { AppConfig, type Job, Jobs, Projects, UploadId } from "@code-to-rag/core"
import { JobRepository, ProjectRepository, SnapshotRepository } from "@code-to-rag/core/outbound"
import { makeTestDatabaseLayer, resetDatabase, testDatabaseUrl } from "@code-to-rag/postgres/testing"
import { Effect, Layer, ManagedRuntime, Option } from "effect"
import { zipSync, type Zippable } from "fflate"
import { randomBytes, randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as nodePath from "node:path"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { StorageConfig } from "@code-to-rag/filesystem"
import { storeUpload, testAdapters } from "./support/adapters.ts"

const url = testDatabaseUrl()
if (url === undefined && process.env["CI"] !== undefined) throw new Error("TEST_DATABASE_URL is required in CI")

const encode = (text: string) => new TextEncoder().encode(text)

const makeLayer = (databaseUrl: string) =>
  Layer.mergeAll(AppConfig.layer, testAdapters).pipe(Layer.provideMerge(makeTestDatabaseLayer(databaseUrl)))

type Services = Layer.Success<ReturnType<typeof makeLayer>>

describe.skipIf(url === undefined)("acquisition pipeline (PostgreSQL)", () => {
  let runtime: ManagedRuntime.ManagedRuntime<Services, unknown>
  let dataDir: string
  const run = <A, E>(effect: Effect.Effect<A, E, Services>) => runtime.runPromise(effect)

  beforeAll(async () => {
    dataDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "code-to-rag-it-"))
    process.env["DATA_DIR"] = dataDir
    process.env["APP_ENCRYPTION_KEY"] = randomBytes(32).toString("base64")
    runtime = ManagedRuntime.make(makeLayer(url!))
    await run(Effect.void)
  })
  afterAll(async () => {
    await runtime.dispose()
    await fs.rm(dataDir, { recursive: true, force: true })
  })
  beforeEach(() => run(resetDatabase))

  /** Writes an "uploaded" archive and creates the project, as the web app does. */
  const createZipProject = async (archive: Uint8Array) => {
    const uploadId = UploadId.make(randomUUID())
    await run(storeUpload(uploadId, archive))
    return run(Projects.createProject({ name: "Gestionale", source: { type: "zip", uploadId } }, null))
  }

  const claimAndRun = async (): Promise<Job> => {
    const job = Option.getOrThrow(await run(JobRepository.use((jobs) => jobs.claim("test-worker"))))
    await run(Jobs.runJob(Jobs.acquisitionPipeline, job))
    return run(JobRepository.use((jobs) => jobs.get(job.id)))
  }

  const sampleArchive = (): Uint8Array => {
    const files: Zippable = {
      "src/orders/service.ts": encode(
        `export const DB_PASSWORD = "Pr0d!Passw0rd#2024"\nexport function createOrder(qty: number) {\n  if (qty > 100) throw new Error("Massimo 100 pezzi")\n}\n`
      ),
      "src/orders/README.md": encode("# Ordini\n"),
      "node_modules/left-pad/index.js": encode("module.exports = {}"),
      "assets/logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]),
      ".env": encode("SECRET=1"),
      "../escape.txt": encode("nope"),
      link: [encode("/etc/passwd"), { os: 3, attrs: (0o120777 << 16) >>> 0 }]
    }
    return zipSync(files)
  }

  it("acquires a zip end to end: filters, masks, stores and cleans up", async () => {
    const summary = await createZipProject(sampleArchive())
    const job = await claimAndRun()
    expect(job.status).toBe("succeeded")
    expect(job.completedPhases).toEqual(["fetch", "ingest", "finalize"])

    const { snapshot } = await run(SnapshotRepository.use((snapshots) => snapshots.get(summary.latestSnapshot!.id)))
    expect(snapshot.status).toBe("ready")
    expect(snapshot.contentHash).toMatch(/^[0-9a-f]{64}$/)
    expect(snapshot.maskedSecrets).toBe(1)

    const files = await run(SnapshotRepository.use((snapshots) => snapshots.listFiles(snapshot.id)))
    expect(Object.fromEntries(files.map((file) => [file.path, file.excludedReason]))).toEqual({
      ".env": "sensitive_file",
      "assets/logo.png": "binary",
      link: "symlink",
      node_modules: "dependency",
      "src/orders/README.md": null,
      "src/orders/service.ts": null
    })

    const content = await run(
      SnapshotRepository.use((snapshots) => snapshots.getFileContent(snapshot.id, "src/orders/service.ts"))
    )
    expect(content.content).not.toContain("Pr0d!Passw0rd#2024")
    expect(content.content).toContain("[REDACTED:assigned-password]")
    expect(content.content).toContain(`throw new Error("Massimo 100 pezzi")`)
    expect(content.secrets).toEqual([{ rule: "assigned-password", line: 1 }])

    const config = await run(Effect.service(StorageConfig))
    expect(await fs.readdir(config.uploadsDir)).toEqual([])
    await expect(fs.access(nodePath.join(config.workDir, job.id))).rejects.toThrow()
    await expect(fs.access(nodePath.join(dataDir, "escape.txt"))).rejects.toThrow()
  })

  it("resumes from the failed phase and stays idempotent", async () => {
    await createZipProject(sampleArchive())
    const job = Option.getOrThrow(await run(JobRepository.use((jobs) => jobs.claim("crashing-worker"))))
    // The first worker completes "fetch" and "ingest", then dies before "finalize".
    for (const phase of Jobs.acquisitionPipeline.phases.slice(0, 2)) {
      await run(phase.run({ job, progress: () => Effect.void }))
      await run(JobRepository.use((jobs) => jobs.completePhase(job.id, phase.name)))
    }
    await run(JobRepository.use((jobs) => jobs.requeueStale(new Date(Date.now() + 1000))))

    const resumed = Option.getOrThrow(await run(JobRepository.use((jobs) => jobs.claim("second-worker"))))
    expect(resumed.completedPhases).toEqual(["fetch", "ingest"])
    // Re-running ingest on top of a completed one must not duplicate files.
    await run(Jobs.acquisitionPipeline.phases[1]!.run({ job: resumed, progress: () => Effect.void }))
    await run(Jobs.runJob(Jobs.acquisitionPipeline, resumed))

    const finished = await run(JobRepository.use((jobs) => jobs.get(job.id)))
    expect(finished.status).toBe("succeeded")
    const files = await run(SnapshotRepository.use((snapshots) => snapshots.listFiles(job.snapshotId)))
    expect(files).toHaveLength(6)
  })

  it("fails permanently on a corrupted archive", async () => {
    const summary = await createZipProject(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]))
    const job = await claimAndRun()
    expect(job.status).toBe("failed")
    expect(job.attempts).toBe(1)
    expect(job.lastError).toMatch(/^fetch: /)
    const project = await run(ProjectRepository.use((projects) => projects.get(summary.project.id)))
    expect(project.latestSnapshot?.status).toBe("failed")
  })

  it("stores Git tokens encrypted only", async () => {
    const summary = await run(
      Projects.createProject(
        {
          name: "Repo",
          source: { type: "git", url: "https://git.example.com/a.git", token: "glpat-abcdefghijklmnopqrst" }
        },
        null
      )
    )
    const source = await run(ProjectRepository.use((projects) => projects.getGitSource(summary.project.id)))
    expect(source.encryptedToken).not.toContain("glpat")
    expect(summary.project.hasCredentials).toBe(true)
  })
})
