import { KnowledgeRepository, NotFoundError } from "@code-to-rag/core"
import { and, asc, count, eq, inArray } from "drizzle-orm"
import { Effect, Layer, Option } from "effect"
import { randomUUID } from "node:crypto"
import { Database, query } from "./client.ts"
import { decodeCard, decodeFeatureMap, decodeFileSummary } from "./rows.ts"
import { card, cardReference, feature, fileSummary, moduleSummary, ragSnapshot, symbolSummary } from "./schema/rag.ts"

/** Rows per INSERT: well below the 65 535 bind parameters of a Postgres statement. */
const INSERT_CHUNK = 1000

const chunks = <A>(items: ReadonlyArray<A>, size: number): Array<ReadonlyArray<A>> => {
  const result: Array<ReadonlyArray<A>> = []
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size))
  return result
}

/** Knowledge base in the `rag` schema. It never joins application tables. */
export const KnowledgeRepositoryLive = Layer.effect(
  KnowledgeRepository,
  Effect.gen(function* () {
    const { db } = yield* Database

    return KnowledgeRepository.of({
      reset: (info, meta) =>
        query("knowledge.reset", () =>
          db.transaction(async (tx) => {
            // Everything else cascades from rag.snapshot.
            await tx.delete(ragSnapshot).where(eq(ragSnapshot.id, info.snapshotId))
            await tx.insert(ragSnapshot).values({
              id: info.snapshotId,
              projectId: info.projectId,
              projectName: info.projectName,
              sourceType: info.sourceType,
              repositoryUrl: info.repositoryUrl,
              revision: info.revision,
              language: meta.language,
              model: meta.model
            })
          })
        ),

      fileSummaries: (id) =>
        query("knowledge.fileSummaries", () =>
          db
            .select({ path: fileSummary.path, summary: fileSummary.summary })
            .from(fileSummary)
            .where(eq(fileSummary.snapshotId, id))
            .orderBy(asc(fileSummary.path))
        ),

      saveFileSummary: (id, summary, provenance) =>
        query("knowledge.saveFileSummary", () =>
          db.transaction(async (tx) => {
            await tx.delete(fileSummary).where(and(eq(fileSummary.snapshotId, id), eq(fileSummary.path, summary.path)))
            await tx
              .delete(symbolSummary)
              .where(and(eq(symbolSummary.snapshotId, id), eq(symbolSummary.path, summary.path)))
            await tx.insert(fileSummary).values({
              snapshotId: id,
              path: summary.path,
              language: summary.language,
              contentHash: summary.contentHash,
              summary: summary.summary,
              parts: summary.parts,
              promptVersion: provenance.promptVersion,
              model: provenance.model
            })
            if (summary.symbols.length > 0) {
              await tx
                .insert(symbolSummary)
                .values(summary.symbols.map((symbol) => ({ snapshotId: id, path: summary.path, ...symbol })))
            }
          })
        ),

      moduleSummaries: (id) =>
        query("knowledge.moduleSummaries", () =>
          db
            .select({ path: moduleSummary.path, summary: moduleSummary.summary })
            .from(moduleSummary)
            .where(eq(moduleSummary.snapshotId, id))
            .orderBy(asc(moduleSummary.path))
        ),

      saveModuleSummary: (id, module, provenance) =>
        query("knowledge.saveModuleSummary", () =>
          db
            .insert(moduleSummary)
            .values({ snapshotId: id, ...module, promptVersion: provenance.promptVersion, model: provenance.model })
            .onConflictDoUpdate({
              target: [moduleSummary.snapshotId, moduleSummary.path],
              set: { summary: module.summary, fileCount: module.fileCount, depth: module.depth }
            })
        ).pipe(Effect.asVoid),

      replaceFeatures: (id, features, provenance) =>
        query("knowledge.replaceFeatures", () =>
          db.transaction(async (tx) => {
            // Cards (and their references) cascade from the features.
            await tx.delete(feature).where(eq(feature.snapshotId, id))
            for (const chunk of chunks(
              features.map((f, position) => ({ f, position })),
              INSERT_CHUNK
            )) {
              await tx.insert(feature).values(
                chunk.map(({ f, position }) => ({
                  id: randomUUID(),
                  snapshotId: id,
                  position,
                  name: f.name,
                  description: f.description,
                  files: [...f.files],
                  symbols: f.symbols.map((s) => ({ path: s.path, qualifiedName: s.qualifiedName })),
                  promptVersion: provenance.promptVersion,
                  model: provenance.model
                }))
              )
            }
          })
        ),

      featureMap: Effect.fnUntraced(function* (id) {
        const [features, root] = yield* Effect.all([
          query("knowledge.features", () =>
            db
              .select({
                id: feature.id,
                position: feature.position,
                name: feature.name,
                description: feature.description,
                files: feature.files,
                symbols: feature.symbols,
                cardId: card.id,
                cardStatus: card.status,
                cardTitle: card.title,
                unreferencedStatements: card.unreferencedStatements
              })
              .from(feature)
              .leftJoin(card, eq(card.featureId, feature.id))
              .where(eq(feature.snapshotId, id))
              .orderBy(asc(feature.position))
          ),
          query("knowledge.projectSummary", () =>
            db
              .select({ summary: moduleSummary.summary })
              .from(moduleSummary)
              .where(and(eq(moduleSummary.snapshotId, id), eq(moduleSummary.path, "")))
          )
        ])
        return yield* decodeFeatureMap({
          projectSummary: root[0]?.summary ?? null,
          features: features.map((row) => ({
            id: row.id,
            position: row.position,
            name: row.name,
            description: row.description,
            files: row.files,
            symbols: row.symbols,
            card:
              row.cardId === null
                ? null
                : {
                    id: row.cardId,
                    status: row.cardStatus,
                    title: row.cardTitle,
                    unreferencedStatements: row.unreferencedStatements
                  }
          }))
        })
      }),

      saveCard: (id, newCard, provenance) =>
        query("knowledge.saveCard", () =>
          db.transaction(async (tx) => {
            await tx.delete(card).where(eq(card.featureId, newCard.featureId))
            const cardId = randomUUID()
            await tx.insert(card).values({
              id: cardId,
              snapshotId: id,
              featureId: newCard.featureId,
              status: newCard.status,
              title: newCard.content.title,
              summary: newCard.content.summary,
              content: newCard.content,
              sourceRevision: newCard.sourceRevision,
              unreferencedStatements: newCard.unreferencedStatements,
              promptVersion: provenance.promptVersion,
              model: provenance.model
            })
            for (const chunk of chunks(newCard.references, INSERT_CHUNK)) {
              await tx.insert(cardReference).values(chunk.map((reference) => ({ cardId, ...reference })))
            }
          })
        ),

      getCard: Effect.fnUntraced(function* (id, cardId) {
        const rows = yield* query("knowledge.getCard", () =>
          db
            .select({
              id: card.id,
              featureId: card.featureId,
              featureName: feature.name,
              status: card.status,
              content: card.content,
              sourceRevision: card.sourceRevision,
              version: card.version,
              unreferencedStatements: card.unreferencedStatements,
              model: card.model,
              createdAt: card.createdAt
            })
            .from(card)
            .innerJoin(feature, eq(feature.id, card.featureId))
            .where(and(eq(card.snapshotId, id), eq(card.id, cardId)))
        )
        const row = rows[0]
        if (row === undefined) return yield* new NotFoundError({ entity: "card", id: cardId })
        return yield* decodeCard(row)
      }),

      fileSummary: Effect.fnUntraced(function* (id, path) {
        const [files, symbols] = yield* Effect.all([
          query("knowledge.fileSummary", () =>
            db
              .select({ path: fileSummary.path, summary: fileSummary.summary, model: fileSummary.model })
              .from(fileSummary)
              .where(and(eq(fileSummary.snapshotId, id), eq(fileSummary.path, path)))
          ),
          query("knowledge.symbolSummaries", () =>
            db
              .select({
                qualifiedName: symbolSummary.qualifiedName,
                kind: symbolSummary.kind,
                startLine: symbolSummary.startLine,
                endLine: symbolSummary.endLine,
                summary: symbolSummary.summary
              })
              .from(symbolSummary)
              .where(and(eq(symbolSummary.snapshotId, id), eq(symbolSummary.path, path)))
              .orderBy(asc(symbolSummary.startLine))
          )
        ])
        const file = files[0]
        if (file === undefined) return Option.none()
        return Option.some(yield* decodeFileSummary({ ...file, symbols }))
      }),

      counts: Effect.fnUntraced(function* (id) {
        const [features, cards] = yield* Effect.all([
          query("knowledge.countFeatures", () =>
            db.select({ total: count() }).from(feature).where(eq(feature.snapshotId, id))
          ),
          query("knowledge.countCards", () => db.select({ total: count() }).from(card).where(eq(card.snapshotId, id)))
        ])
        return { features: features[0]?.total ?? 0, cards: cards[0]?.total ?? 0 }
      }),

      deleteSnapshots: (ids) =>
        ids.length === 0
          ? Effect.void
          : query("knowledge.deleteSnapshots", () =>
              db.delete(ragSnapshot).where(inArray(ragSnapshot.id, [...ids]))
            ).pipe(Effect.asVoid)
    })
  })
)
