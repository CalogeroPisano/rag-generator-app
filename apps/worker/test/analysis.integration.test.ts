import {
  acquisitionPipeline,
  AnalysisRepository,
  analysisPipeline,
  AppConfig,
  CodeAnalyzer,
  createProject,
  type Job,
  JobRepository,
  requestAnalysis,
  runJob,
  SecretBox,
  SnapshotRepository,
  UploadId,
  uploadPath
} from "@code-to-rag/core"
import { makeTestDatabaseLayer, resetDatabase, testDatabaseUrl } from "@code-to-rag/db/testing"
import { Effect, Layer, ManagedRuntime, Option } from "effect"
import { zipSync } from "fflate"
import { randomBytes, randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as nodePath from "node:path"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

const url = testDatabaseUrl()
if (url === undefined && process.env["CI"] !== undefined) throw new Error("TEST_DATABASE_URL is required in CI")

const encode = (text: string) => new TextEncoder().encode(text)

const makeLayer = (databaseUrl: string) =>
  Layer.mergeAll(SecretBox.layer, CodeAnalyzer.layer).pipe(
    Layer.provideMerge(AppConfig.layer),
    Layer.provideMerge(makeTestDatabaseLayer(databaseUrl))
  )
type Services = Layer.Success<ReturnType<typeof makeLayer>>

/** A small polyglot project: TypeScript with aliases, Python, Go module, Java and C#. */
const sampleProject = () =>
  zipSync({
    "web/tsconfig.json": encode(`{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }`),
    "web/src/orders/service.ts": encode(
      `import { formatPrice } from "@/lib/money"\nimport { z } from "zod"\n/** Creates orders. */\nexport class OrderService {\n  create(qty: number) {\n    if (qty > 100) throw new Error("Massimo 100 pezzi")\n    return formatPrice(qty)\n  }\n}\n`
    ),
    "web/src/lib/money.ts": encode(
      `export const MAX_PRICE = 1000\nexport function formatPrice(value: number) { return value.toFixed(2) }\n`
    ),
    "web/src/broken.ts": encode(`import { gone } from "./missing"\n`),
    "py/shop/__init__.py": encode(""),
    "py/shop/orders.py": encode(`from .models import Order\nclass OrderService:\n    def create(self): pass\n`),
    "py/shop/models.py": encode(`class Order:\n    pass\n`),
    "go/go.mod": encode("module example.com/shop\n"),
    "go/internal/db/db.go": encode(`package db\nfunc Open() {}\n`),
    "go/cmd/api/main.go": encode(`package main\nimport "example.com/shop/internal/db"\nfunc main() { db.Open() }\n`),
    "java/src/com/acme/Money.java": encode(`package com.acme;\npublic class Money {}\n`),
    "java/src/com/acme/orders/Orders.java": encode(
      `package com.acme.orders;\nimport com.acme.Money;\nimport java.util.List;\npublic class Orders { public void create() {} }\n`
    ),
    "cs/Common.cs": encode(`namespace Acme.Common { public class Strings {} }\n`),
    "cs/Orders.cs": encode(`using Acme.Common;\nusing System;\nnamespace Acme.Orders;\npublic class OrderService {}\n`),
    "README.md": encode("# Shop\n")
  })

describe.skipIf(url === undefined)("static analysis pipeline (PostgreSQL)", () => {
  let runtime: ManagedRuntime.ManagedRuntime<Services, unknown>
  let dataDir: string
  const run = <A, E>(effect: Effect.Effect<A, E, Services>) => runtime.runPromise(effect)

  beforeAll(async () => {
    dataDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "code-to-rag-analysis-"))
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

  const claim = () => run(JobRepository.use((jobs) => jobs.claim("test-worker"))).then(Option.getOrThrow)

  const runClaimed = async (): Promise<Job> => {
    const job = await claim()
    if (job.type === "acquisition") await run(runJob(acquisitionPipeline, job))
    else await run(runJob(analysisPipeline, job))
    return run(JobRepository.use((jobs) => jobs.get(job.id)))
  }

  /** Acquires the sample project and runs the analysis job queued at the end of it. */
  const acquireAndAnalyze = async () => {
    const uploadId = UploadId.make(randomUUID())
    const config = await run(Effect.service(AppConfig))
    await fs.mkdir(config.uploadsDir, { recursive: true })
    await fs.writeFile(uploadPath(config.uploadsDir, uploadId), sampleProject())
    const summary = await run(createProject({ name: "Shop", source: { type: "zip", uploadId } }, null))
    const acquisition = await runClaimed()
    expect(acquisition.status).toBe("succeeded")
    const analysis = await runClaimed()
    return { snapshotId: summary.latestSnapshot!.id, analysis }
  }

  it("queues the analysis after acquisition and stores symbols and resolved dependencies", async () => {
    const { snapshotId, analysis } = await acquireAndAnalyze()
    expect(analysis.type).toBe("analysis")
    expect(analysis.status).toBe("succeeded")
    expect(analysis.completedPhases).toEqual(["parse", "resolve", "finalize"])

    const { snapshot } = await run(SnapshotRepository.use((snapshots) => snapshots.get(snapshotId)))
    expect(snapshot.analysisStatus).toBe("ready")
    expect(snapshot.symbolCount).toBeGreaterThan(10)

    const service = await run(
      AnalysisRepository.use((repository) => repository.fileAnalysis(snapshotId, "web/src/orders/service.ts"))
    )
    expect(service.symbols.map((symbol) => `${symbol.kind} ${symbol.qualifiedName}`)).toEqual([
      "class OrderService",
      "method OrderService.create"
    ])
    expect(service.symbols[0]?.doc).toBe("/** Creates orders. */")
    expect(
      service.imports.map((dependency) => [dependency.specifier, dependency.targetKind, dependency.target])
    ).toEqual([
      ["@/lib/money", "file", "web/src/lib/money.ts"],
      ["zod", "external", null]
    ])

    const money = await run(
      AnalysisRepository.use((repository) => repository.fileAnalysis(snapshotId, "web/src/lib/money.ts"))
    )
    expect(money.importedBy.map((dependent) => dependent.path)).toEqual(["web/src/orders/service.ts"])

    const targetOf = async (path: string) =>
      (await run(AnalysisRepository.use((repository) => repository.fileAnalysis(snapshotId, path)))).imports.map(
        (dependency) => [dependency.targetKind, dependency.target ?? dependency.externalName]
      )
    expect(await targetOf("web/src/broken.ts")).toEqual([["unresolved", null]])
    expect(await targetOf("py/shop/orders.py")).toEqual([["file", "py/shop/models.py"]])
    expect(await targetOf("go/cmd/api/main.go")).toEqual([["directory", "go/internal/db"]])
    expect(await targetOf("java/src/com/acme/orders/Orders.java")).toEqual([
      ["file", "java/src/com/acme/Money.java"],
      ["external", "java.util"]
    ])
    expect(await targetOf("cs/Orders.cs")).toEqual([
      ["namespace", "Acme.Common"],
      ["external", "System"]
    ])

    // Go packages and C# namespaces count their importers too.
    const db = await run(
      AnalysisRepository.use((repository) => repository.fileAnalysis(snapshotId, "go/internal/db/db.go"))
    )
    expect(db.importedBy.map((dependent) => dependent.path)).toEqual(["go/cmd/api/main.go"])
    const common = await run(
      AnalysisRepository.use((repository) => repository.fileAnalysis(snapshotId, "cs/Common.cs"))
    )
    expect(common.importedBy.map((dependent) => dependent.path)).toEqual(["cs/Orders.cs"])
  })

  it("searches symbols and summarises dependencies", async () => {
    const { snapshotId } = await acquireAndAnalyze()
    const page = await run(
      AnalysisRepository.use((repository) =>
        repository.listSymbols(snapshotId, {
          search: "orderserv",
          kind: "class",
          exportedOnly: false,
          limit: 10,
          offset: 0
        })
      )
    )
    expect(page.items.map((symbol) => symbol.path).sort()).toEqual([
      "cs/Orders.cs",
      "py/shop/orders.py",
      "web/src/orders/service.ts"
    ])
    expect(page.total).toBe(3)

    const overview = await run(AnalysisRepository.use((repository) => repository.overview(snapshotId)))
    expect(overview.externals.map((external) => external.name).sort()).toEqual(["System", "java.util", "zod"])
    expect(overview.hubs[0]).toMatchObject({ importedBy: 1 })
    expect(Object.fromEntries(overview.languages.map((row) => [row.language, row.files]))).toMatchObject({
      typescript: 3,
      python: 3,
      go: 2,
      java: 2,
      csharp: 2
    })
    const files = await run(SnapshotRepository.use((snapshots) => snapshots.listFiles(snapshotId)))
    expect(files.find((file) => file.path === "README.md")?.parseErrors).toBeNull()
    expect(files.find((file) => file.path === "web/src/lib/money.ts")?.parseErrors).toBe(0)
  })

  it("re-analysis is idempotent and an active analysis is not duplicated", async () => {
    const { snapshotId } = await acquireAndAnalyze()
    const before = (await run(SnapshotRepository.use((snapshots) => snapshots.get(snapshotId)))).snapshot

    const first = await run(requestAnalysis(snapshotId))
    const second = await run(requestAnalysis(snapshotId))
    expect(second.id).toBe(first.id)

    const job = await claim()
    // Simulate a crash after "parse": run it twice, then let the runner finish.
    await run(analysisPipeline.phases[0]!.run({ job, progress: () => Effect.void }))
    await run(runJob(analysisPipeline, job))

    const after = (await run(SnapshotRepository.use((snapshots) => snapshots.get(snapshotId)))).snapshot
    expect(after.symbolCount).toBe(before.symbolCount)
    expect(after.dependencyCount).toBe(before.dependencyCount)
    expect(after.analysisStatus).toBe("ready")
  })
})
