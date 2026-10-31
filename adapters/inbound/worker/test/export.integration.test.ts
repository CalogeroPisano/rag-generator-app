import {
  AppConfig,
  type CardContent,
  Evaluation,
  Export,
  type Job,
  Jobs,
  Knowledge,
  type ProjectId,
  Projects,
  type SnapshotId,
  UploadId
} from "@code-to-rag/core"
import { EXPORT_TABLES, JobRepository, KnowledgeRepository } from "@code-to-rag/core/outbound"
import {
  scriptedDecisionModel,
  scriptedEmbeddingModel,
  scriptedLanguageModel,
  scriptedModelRegistry
} from "@code-to-rag/core/testing"
import { Database } from "@code-to-rag/postgres"
import { makeTestDatabaseLayer, resetDatabase, testDatabaseUrl } from "@code-to-rag/postgres/testing"
import { Effect, Layer, ManagedRuntime, Option } from "effect"
import { strFromU8, unzipSync } from "fflate"
import { randomBytes, randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as nodePath from "node:path"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { card as ordersCard, defaultRespond, sampleProject } from "./support/understanding.ts"
import { storeUpload, testAdapters } from "./support/adapters.ts"

const url = testDatabaseUrl()
if (url === undefined && process.env["CI"] !== undefined) throw new Error("TEST_DATABASE_URL is required in CI")

const pricesCard: CardContent = {
  title: "Prices",
  summary: "Prices are shown with two decimals; it's 'quoted'.",
  behavior: [{ text: "Formats prices.", references: [{ path: "web/src/lib/money.ts", startLine: 1, endLine: 1 }] }],
  configuration: [],
  parameters: [],
  limits: [],
  validationRules: [],
  errors: []
}

const makeLayer = (databaseUrl: string) =>
  scriptedModelRegistry.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        testAdapters,
        scriptedEmbeddingModel(),
        scriptedLanguageModel((request) => {
          switch (request.prompt.id) {
            case "feature-map":
              return {
                features: [
                  { name: "Orders", description: "Create orders.", files: ["web/src/orders/service.ts"], symbols: [] },
                  { name: "Prices", description: "Format prices.", files: ["web/src/lib/money.ts"], symbols: [] }
                ]
              }
            case "card":
              return /^Feature: Prices$/m.test(request.input) ? pricesCard : ordersCard
            default:
              return defaultRespond(request)
          }
        }),
        scriptedDecisionModel()
      )
    ),
    Layer.provideMerge(AppConfig.layer),
    Layer.provideMerge(makeTestDatabaseLayer(databaseUrl))
  )
type Services = Layer.Success<ReturnType<typeof makeLayer>>

const reviewer = { id: "user-1", name: "Revisore" }

/** Description of the `rag` schema, to compare the one the script creates with the migrated one. */
const catalogQuery = `
  select 'column' as kind, c.relname || '.' || a.attname as name,
         concat_ws(' ', format_type(a.atttypid, a.atttypmod), a.attnotnull, a.attgenerated, pg_get_expr(d.adbin, d.adrelid)) as definition
    from pg_attribute a join pg_class c on c.oid = a.attrelid
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where c.relnamespace = 'rag'::regnamespace and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
  union all
  select 'constraint', conrelid::regclass::text || '.' || conname, pg_get_constraintdef(oid)
    from pg_constraint where connamespace = 'rag'::regnamespace
  union all
  select 'index', c.relname, pg_get_indexdef(c.oid)
    from pg_class c where c.relnamespace = 'rag'::regnamespace and c.relkind = 'i'
  order by 1, 2`

describe.skipIf(url === undefined)("Knowledge export (PostgreSQL)", () => {
  let runtime: ManagedRuntime.ManagedRuntime<Services, unknown>
  let dataDir: string
  const run = <A, E>(effect: Effect.Effect<A, E, Services>) => runtime.runPromise(effect)
  const sqlQuery = (text: string) =>
    run(Database.use(({ pool }) => Effect.promise(() => pool.query<Record<string, unknown>>(text)))).then(
      (result) => result.rows
    )

  beforeAll(async () => {
    dataDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "code-to-rag-export-"))
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

  const drain = async () => {
    for (;;) {
      const claimed = await run(JobRepository.use((jobs) => jobs.claim("test-worker")))
      if (Option.isNone(claimed)) return
      const job: Job = claimed.value
      if (job.type === "acquisition") await run(Jobs.runJob(Jobs.acquisitionPipeline, job))
      else if (job.type === "analysis") await run(Jobs.runJob(Jobs.analysisPipeline, job))
      else if (job.type === "understanding") await run(Jobs.runJob(Jobs.understandingPipeline, job))
      else if (job.type === "indexing") await run(Jobs.runJob(Jobs.indexingPipeline, job))
      else throw new Error(`Unexpected job ${job.type}`)
    }
  }

  /** A project with two cards (Orders approved), indexed, with a correction and a test question on each feature. */
  const exportedProject = async (name = "Shop") => {
    const uploadId = UploadId.make(randomUUID())
    await run(storeUpload(uploadId, sampleProject()))
    const summary = await run(Projects.createProject({ name, source: { type: "zip", uploadId } }, null))
    const projectId: ProjectId = summary.project.id
    const snapshotId: SnapshotId = summary.latestSnapshot!.id
    await drain()
    const refused = await run(Effect.flip(Export.prepareExport(projectId, false)))
    expect(refused._tag).toBe("InvalidInputError")
    await run(Knowledge.requestUnderstanding(snapshotId))
    await drain()
    const features = (await run(KnowledgeRepository.use((k) => k.featureMap(snapshotId)))).features
    for (const feature of features) {
      if (feature.name === "Orders")
        await run(Knowledge.setCardStatus(snapshotId, feature.card!.id, "approved", reviewer))
      await run(
        KnowledgeRepository.use((k) =>
          k.addCorrection({
            projectId,
            featureId: feature.id,
            featureName: feature.name,
            text: `Correction of ${feature.name}`,
            author: reviewer
          })
        )
      )
      await run(
        Evaluation.addTestQuestion(
          snapshotId,
          { featureId: feature.id, question: `How does ${feature.name} work?`, expectedAnswer: null },
          reviewer
        )
      )
    }
    return { projectId, snapshotId }
  }

  const exportBytes = async (projectId: ProjectId, format: Export.ExportFormat, approvedOnly: boolean) => {
    const parts: Array<Uint8Array> = []
    const plan = await run(Export.prepareExport(projectId, approvedOnly))
    await run(Export.writeExport(plan, format, (bytes) => Effect.sync(() => parts.push(bytes))))
    return Buffer.concat(parts)
  }

  it("previews what an export contains, for every card or approved ones only", async () => {
    const { projectId } = await exportedProject()
    const all = await run(Effect.flatMap(Export.prepareExport(projectId, false), Export.exportPreview))
    expect(all.fileName).toMatch(/^shop-[0-9a-f]{10}-knowledge$/)
    expect(all.rows).toMatchObject({ snapshot: 1, feature: 2, card: 2, correction: 2, test_question: 2 })
    expect(all.rows.chunk).toBeGreaterThan(2)
    expect(all.embeddings).toHaveLength(1)
    expect(all.embeddings[0]?.chunks).toBe(all.rows.chunk)

    const approved = await run(Effect.flatMap(Export.prepareExport(projectId, true), Export.exportPreview))
    expect(approved.fileName).toMatch(/-knowledge-approved$/)
    expect(approved.rows).toMatchObject({ snapshot: 1, feature: 1, card: 1, correction: 1, test_question: 1 })
    expect(approved.rows.chunk).toBeLessThan(all.rows.chunk)
    // Summaries describe the code, not the cards: always exported.
    expect(approved.rows.file_summary).toBe(all.rows.file_summary)
  })

  it("writes a zip with the manifest and one JSONL file per table", async () => {
    const { projectId, snapshotId } = await exportedProject()
    const files = unzipSync(new Uint8Array(await exportBytes(projectId, "jsonl", true)))
    expect(Object.keys(files).sort()).toEqual(
      ["manifest.json", ...EXPORT_TABLES.map((table) => `${table}.jsonl`)].sort()
    )
    const manifest = JSON.parse(strFromU8(files["manifest.json"]!)) as Export.ExportManifest
    expect(manifest).toMatchObject({
      format: "code-to-rag-knowledge",
      formatVersion: 1,
      project: { id: projectId, name: "Shop", sourceType: "zip", repositoryUrl: null },
      snapshot: { id: snapshotId },
      cards: "approved-only"
    })
    const lines = (table: string) =>
      strFromU8(files[`${table}.jsonl`]!)
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    for (const table of manifest.tables) {
      expect(lines(table.name.slice(4))).toHaveLength(table.rows)
    }
    const [card] = lines("card")
    expect(card).toMatchObject({
      status: "approved",
      title: "Orders",
      reviewed_by: "Revisore",
      snapshot_id: snapshotId
    })
    expect((card!["content"] as CardContent).behavior[0]?.references).toHaveLength(1)
    const chunk = lines("chunk")[0]!
    // No serial id (it would collide in another database) and no generated column.
    expect(Object.keys(chunk)).not.toContain("id")
    expect(Object.keys(chunk)).not.toContain("search_vector")
    expect(Array.isArray(chunk["embedding"])).toBe(true)
    expect((chunk["embedding"] as Array<number>).length).toBe(manifest.embeddings[0]?.dimensions)
    expect(lines("correction").map((row) => row["text"])).toEqual(["Correction of Orders"])
  })

  it("writes a SQL script that recreates the rag schema and can be run again", async () => {
    const { projectId } = await exportedProject("Shop\nDROP TABLE rag.card; --")
    const script = (await exportBytes(projectId, "sql", false)).toString("utf8")
    // The project name stays inside the comment.
    expect(script).toContain("-- Project: Shop DROP TABLE rag.card; -- (")

    const rows = async () =>
      Object.fromEntries(
        await Promise.all(
          EXPORT_TABLES.map(async (table) => {
            const result = await sqlQuery(`select to_jsonb(t) - 'id' - 'search_vector' as row from rag.${table} t`)
            return [table, result.map((row) => JSON.stringify(row["row"])).sort()] as const
          })
        )
      )
    const catalog = await sqlQuery(catalogQuery)
    const before = await rows()
    expect(before.card).toHaveLength(2)

    // An empty database: the script creates the schema, then fills it.
    await sqlQuery("drop schema rag cascade")
    await sqlQuery(script)
    expect(await sqlQuery(catalogQuery)).toEqual(catalog)
    expect(await rows()).toEqual(before)
    // The full-text column is generated again in the target database.
    const [searchable] = await sqlQuery(
      "select count(*)::int as n from rag.chunk where search_vector @@ 'orders'::tsquery"
    )
    expect(searchable?.["n"]).toBeGreaterThan(0)

    // Running it again replaces the project's rows.
    await sqlQuery(script)
    expect(await rows()).toEqual(before)
  })

  it("refuses to export while the cards are being generated again", async () => {
    const { projectId, snapshotId } = await exportedProject()
    await run(Knowledge.requestUnderstanding(snapshotId))
    const error = await run(Effect.flip(Export.prepareExport(projectId, false)))
    expect(error).toMatchObject({
      _tag: "InvalidInputError",
      message: "Attendi la fine della generazione delle schede"
    })
  })
})
