import { ModelCallRecorder } from "@code-to-rag/core/outbound"
import { NotFoundError, ProjectId, UnderstandingRepository } from "@code-to-rag/core/outbound"
import { and, asc, eq, inArray, sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Database, query } from "./client.ts"
import { decodeModelCallStats } from "./rows.ts"
import { modelCall, project, snapshot, sourceBlob, sourceFile, symbol } from "./schema/app.ts"

/** Paths per query when loading file contents. */
const PATH_CHUNK = 500

export const UnderstandingRepositoryLive = Layer.effect(
  UnderstandingRepository,
  Effect.gen(function* () {
    const { db } = yield* Database

    return UnderstandingRepository.of({
      setStatus: (id, status) =>
        query("understanding.setStatus", () =>
          db.update(snapshot).set({ understandingStatus: status }).where(eq(snapshot.id, id))
        ).pipe(Effect.asVoid),

      complete: (id, counts) =>
        query("understanding.complete", () =>
          db
            .update(snapshot)
            .set({
              understandingStatus: "ready",
              understoodAt: new Date(),
              featureCount: counts.features,
              cardCount: counts.cards
            })
            .where(eq(snapshot.id, id))
        ).pipe(Effect.asVoid),

      snapshotInfo: Effect.fnUntraced(function* (id) {
        const rows = yield* query("understanding.snapshotInfo", () =>
          db
            .select({
              projectId: project.id,
              projectName: project.name,
              sourceType: project.sourceType,
              repositoryUrl: project.repositoryUrl,
              commitSha: snapshot.commitSha,
              contentHash: snapshot.contentHash
            })
            .from(snapshot)
            .innerJoin(project, eq(project.id, snapshot.projectId))
            .where(eq(snapshot.id, id))
        )
        const row = rows[0]
        if (row === undefined) return yield* new NotFoundError({ entity: "snapshot", id })
        return {
          snapshotId: id,
          projectId: ProjectId.make(row.projectId),
          projectName: row.projectName,
          sourceType: row.sourceType === "git" ? "git" : "zip",
          repositoryUrl: row.repositoryUrl,
          revision: row.commitSha ?? row.contentHash ?? "unknown"
        }
      }),

      loadFiles: (id, paths) =>
        Effect.forEach(
          Array.from({ length: Math.ceil(paths.length / PATH_CHUNK) }, (_, i) =>
            paths.slice(i * PATH_CHUNK, (i + 1) * PATH_CHUNK)
          ),
          (chunk) =>
            query("understanding.loadFiles", () =>
              db
                .select({
                  path: sourceFile.path,
                  language: sourceFile.language,
                  contentHash: sourceBlob.hash,
                  content: sourceBlob.content
                })
                .from(sourceFile)
                .innerJoin(sourceBlob, eq(sourceBlob.hash, sourceFile.contentHash))
                .where(and(eq(sourceFile.snapshotId, id), inArray(sourceFile.path, [...chunk])))
                .orderBy(asc(sourceFile.path))
            )
        ).pipe(Effect.map((groups) => groups.flat())),

      declarations: (id) =>
        query("understanding.declarations", () =>
          db
            .select({
              path: sourceFile.path,
              kind: symbol.kind,
              qualifiedName: symbol.qualifiedName,
              container: symbol.container,
              exported: symbol.exported,
              startLine: symbol.startLine,
              endLine: symbol.endLine
            })
            .from(symbol)
            .innerJoin(sourceFile, eq(sourceFile.id, symbol.fileId))
            .where(eq(symbol.snapshotId, id))
            .orderBy(asc(sourceFile.path), asc(symbol.startLine))
        ),

      modelCallStats: Effect.fnUntraced(function* (id) {
        const failed = sql`${modelCall.outcome} <> 'success'`
        const totals = {
          calls: sql<number>`count(*)`.mapWith(Number),
          failures: sql<number>`count(*) filter (where ${failed})`.mapWith(Number),
          inputTokens: sql<number>`coalesce(sum(${modelCall.inputTokens}), 0)`.mapWith(Number),
          outputTokens: sql<number>`coalesce(sum(${modelCall.outputTokens}), 0)`.mapWith(Number),
          durationMs: sql<number>`coalesce(sum(${modelCall.durationMs}), 0)`.mapWith(Number)
        }
        const [total, byTask, models] = yield* Effect.all([
          query("understanding.callTotals", () =>
            db.select(totals).from(modelCall).where(eq(modelCall.snapshotId, id))
          ),
          query("understanding.callsByTask", () =>
            db
              .select({ task: modelCall.task, ...totals })
              .from(modelCall)
              .where(eq(modelCall.snapshotId, id))
              .groupBy(modelCall.task)
              .orderBy(asc(modelCall.task))
          ),
          query("understanding.callModels", () =>
            db
              .selectDistinct({ model: modelCall.model })
              .from(modelCall)
              .where(eq(modelCall.snapshotId, id))
              .orderBy(asc(modelCall.model))
          )
        ])
        return yield* decodeModelCallStats({
          total: total[0] ?? { calls: 0, failures: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 },
          byTask,
          models: models.map((row) => row.model)
        })
      })
    })
  })
)

/**
 * Writes the model call log. A failure to record is logged and swallowed: it
 * must not fail the model call it describes.
 */
export const ModelCallRecorderLive = Layer.effect(
  ModelCallRecorder,
  Effect.gen(function* () {
    const { db } = yield* Database
    return ModelCallRecorder.of({
      record: (call) =>
        query("modelCall.record", () =>
          db.insert(modelCall).values({
            jobId: call.jobId ?? null,
            snapshotId: call.snapshotId ?? null,
            phase: call.phase,
            task: call.task,
            promptVersion: call.promptVersion,
            provider: call.provider,
            model: call.model,
            attempt: call.attempt,
            outcome: call.outcome,
            durationMs: call.durationMs,
            inputTokens: call.inputTokens,
            outputTokens: call.outputTokens,
            error: call.error
          })
        ).pipe(
          Effect.asVoid,
          Effect.catch((error) => Effect.logWarning("Model call not recorded", error.operation))
        )
    })
  })
)
