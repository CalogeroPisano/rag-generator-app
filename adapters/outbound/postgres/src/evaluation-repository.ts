import { EvaluationRepository, featureKey, NotFoundError, type TestResult } from "@code-to-rag/core/outbound"
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { randomUUID } from "node:crypto"
import { Database, query } from "./client.ts"
import { decodeTestQuestion, decodeTestResult, decodeTestRun } from "./rows.ts"
import { feature, ragSnapshot, testQuestion, testResult, testRun } from "./schema/rag.ts"

/** Most recent runs listed per snapshot. */
const MAX_RUNS = 20

const runView = (row: typeof testRun.$inferSelect, revision: string) =>
  decodeTestRun({
    id: row.id,
    snapshotId: row.snapshotId,
    revision,
    status: row.status,
    model: row.model,
    embeddingModel: row.embeddingModel,
    topK: row.topK,
    approvedOnly: row.approvedOnly,
    questions: row.questions,
    retrievalHits: row.retrievalHits,
    firstHits: row.firstHits,
    mrr: row.mrr,
    correct: row.correct,
    partial: row.partial,
    incorrect: row.incorrect,
    noAnswer: row.noAnswer,
    unjudged: row.unjudged,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt
  })

const resultValues = (runId: string, result: TestResult) => ({
  runId,
  questionId: result.questionId,
  question: result.question,
  expectedFeatureId: result.expectedFeatureId,
  expectedFeatureName: result.expectedFeatureName,
  retrieved: result.retrieved,
  rank: result.rank,
  answer: result.answer,
  citedFeatureIds: [...result.citedFeatureIds],
  verdict: result.verdict,
  note: result.note
})

/** Test questions and runs in the `rag` schema. */
export const EvaluationRepositoryLive = Layer.effect(
  EvaluationRepository,
  Effect.gen(function* () {
    const { db } = yield* Database

    const notFound = (id: string) => (rows: ReadonlyArray<unknown>) =>
      rows.length > 0 ? Effect.void : Effect.fail(new NotFoundError({ entity: "test question", id }))

    return EvaluationRepository.of({
      questions: Effect.fnUntraced(function* (id, projectId) {
        const rows = yield* query("evaluation.questions", () =>
          db
            .select({ question: testQuestion, currentFeatureId: feature.id })
            .from(testQuestion)
            // Attached to a feature of another snapshot's map counts as orphan here.
            .leftJoin(feature, and(eq(feature.id, testQuestion.featureId), eq(feature.snapshotId, id)))
            .where(eq(testQuestion.projectId, projectId))
            .orderBy(asc(testQuestion.createdAt), asc(testQuestion.id))
        )
        return yield* Effect.forEach(rows, ({ question, currentFeatureId }) =>
          decodeTestQuestion({
            id: question.id,
            featureId: currentFeatureId,
            featureName: question.featureName,
            question: question.question,
            expectedAnswer: question.expectedAnswer,
            origin: question.origin,
            authorName: question.authorName,
            createdAt: question.createdAt
          })
        )
      }),

      addQuestions: (projectId, questions) =>
        questions.length === 0
          ? Effect.void
          : query("evaluation.addQuestions", () =>
              db.insert(testQuestion).values(
                questions.map((q) => ({
                  id: randomUUID(),
                  projectId,
                  featureId: q.featureId,
                  featureName: q.featureName,
                  featureKey: featureKey(q.featureName),
                  question: q.question,
                  expectedAnswer: q.expectedAnswer,
                  origin: q.origin,
                  authorName: q.authorName,
                  model: q.provenance?.model ?? null,
                  promptVersion: q.provenance?.promptVersion ?? null
                }))
              )
            ).pipe(Effect.asVoid),

      updateQuestion: (projectId, questionId, update) =>
        query("evaluation.updateQuestion", () =>
          db
            .update(testQuestion)
            .set({
              featureId: update.featureId,
              featureName: update.featureName,
              featureKey: featureKey(update.featureName),
              question: update.question,
              expectedAnswer: update.expectedAnswer
            })
            .where(and(eq(testQuestion.projectId, projectId), eq(testQuestion.id, questionId)))
            .returning({ id: testQuestion.id })
        ).pipe(Effect.flatMap(notFound(questionId))),

      deleteQuestion: (projectId, questionId) =>
        query("evaluation.deleteQuestion", () =>
          db
            .delete(testQuestion)
            .where(and(eq(testQuestion.projectId, projectId), eq(testQuestion.id, questionId)))
            .returning({ id: testQuestion.id })
        ).pipe(Effect.flatMap(notFound(questionId))),

      reattachQuestions: (id, projectId) =>
        query("evaluation.reattachQuestions", () =>
          db.transaction(async (tx) => {
            const features = await tx
              .select({ id: feature.id, name: feature.name })
              .from(feature)
              .where(eq(feature.snapshotId, id))
            const byKey = new Map(features.map((f) => [featureKey(f.name), f.id]))
            const questions = await tx
              .select({ id: testQuestion.id, featureKey: testQuestion.featureKey })
              .from(testQuestion)
              .where(eq(testQuestion.projectId, projectId))
            for (const row of questions) {
              await tx
                .update(testQuestion)
                .set({ featureId: byKey.get(row.featureKey) ?? null })
                .where(eq(testQuestion.id, row.id))
            }
          })
        ),

      startRun: (run) =>
        query("evaluation.startRun", () =>
          db.transaction(async (tx) => {
            // A retried job starts its run again: results cascade.
            await tx.delete(testRun).where(eq(testRun.id, run.id))
            await tx.insert(testRun).values({ ...run, status: "running" })
          })
        ),

      getRun: Effect.fnUntraced(function* (runId) {
        const [runs, results] = yield* Effect.all([
          query("evaluation.getRun", () =>
            db
              .select({ run: testRun, revision: ragSnapshot.revision })
              .from(testRun)
              .innerJoin(ragSnapshot, eq(ragSnapshot.id, testRun.snapshotId))
              .where(eq(testRun.id, runId))
          ),
          query("evaluation.results", () =>
            db.select().from(testResult).where(eq(testResult.runId, runId)).orderBy(asc(testResult.id))
          )
        ])
        const row = runs[0]
        if (row === undefined) return yield* new NotFoundError({ entity: "test run", id: runId })
        return {
          run: yield* runView(row.run, row.revision),
          results: yield* Effect.forEach(results, (result) =>
            decodeTestResult({
              questionId: result.questionId,
              question: result.question,
              expectedFeatureId: result.expectedFeatureId,
              expectedFeatureName: result.expectedFeatureName,
              retrieved: result.retrieved,
              rank: result.rank,
              answer: result.answer,
              citedFeatureIds: result.citedFeatureIds,
              verdict: result.verdict,
              note: result.note
            })
          )
        }
      }),

      saveResult: (runId, result) =>
        query("evaluation.saveResult", () => {
          const values = resultValues(runId, result)
          return db
            .insert(testResult)
            .values(values)
            .onConflictDoUpdate({ target: [testResult.runId, testResult.questionId], set: values })
        }).pipe(Effect.asVoid),

      finishRun: (runId, status, totals) =>
        query("evaluation.finishRun", () =>
          db
            .update(testRun)
            .set({ status, ...totals, finishedAt: sql`now()` })
            .where(eq(testRun.id, runId))
        ).pipe(Effect.asVoid),

      runs: Effect.fnUntraced(function* (id) {
        const rows = yield* query("evaluation.runs", () =>
          db
            .select({ run: testRun, revision: ragSnapshot.revision })
            .from(testRun)
            .innerJoin(ragSnapshot, eq(ragSnapshot.id, testRun.snapshotId))
            .where(
              inArray(
                ragSnapshot.projectId,
                db.select({ projectId: ragSnapshot.projectId }).from(ragSnapshot).where(eq(ragSnapshot.id, id))
              )
            )
            .orderBy(desc(testRun.startedAt))
            .limit(MAX_RUNS)
        )
        return yield* Effect.forEach(rows, (row) => runView(row.run, row.revision))
      })
    })
  })
)
