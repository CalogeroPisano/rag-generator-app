import { featureKey, KnowledgeRepository, NotFoundError } from "@code-to-rag/core/outbound"
import { and, asc, count, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm"
import { Effect, Layer, Option } from "effect"
import { randomUUID } from "node:crypto"
import { Database, query } from "./client.ts"
import { decodeCard, decodeCorrection, decodeFeatureMap, decodeFileSummary } from "./rows.ts"
import {
  card,
  cardReference,
  cardVerification,
  chunk as indexChunk,
  correction,
  feature,
  fileSummary,
  moduleSummary,
  ragSnapshot,
  symbolSummary,
  testQuestion
} from "./schema/rag.ts"

/** Rows per INSERT (and values per IN list): well below the 65 535 bind parameters of a Postgres statement. */
const INSERT_CHUNK = 1000

const chunks = <A>(items: ReadonlyArray<A>, size: number): Array<ReadonlyArray<A>> => {
  const result: Array<ReadonlyArray<A>> = []
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size))
  return result
}

const correctionView = (row: typeof correction.$inferSelect) => ({
  id: row.id,
  featureName: row.featureName,
  featureId: row.featureId,
  text: row.text,
  authorName: row.authorName,
  createdAt: row.createdAt,
  appliedVersion: row.appliedVersion
})

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
        const [features, root, orphans] = yield* Effect.all([
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
                cardChange: card.change,
                cardTitle: card.title,
                cardVersion: card.version,
                unreferencedStatements: card.unreferencedStatements,
                verifiedVersion: cardVerification.cardVersion,
                issues: cardVerification.issues
              })
              .from(feature)
              .leftJoin(card, eq(card.featureId, feature.id))
              .leftJoin(cardVerification, eq(cardVerification.cardId, card.id))
              .where(eq(feature.snapshotId, id))
              .orderBy(asc(feature.position))
          ),
          query("knowledge.projectSummary", () =>
            db
              .select({ summary: moduleSummary.summary })
              .from(moduleSummary)
              .where(and(eq(moduleSummary.snapshotId, id), eq(moduleSummary.path, "")))
          ),
          query("knowledge.orphanCorrections", () =>
            db
              .select()
              .from(correction)
              .innerJoin(ragSnapshot, eq(ragSnapshot.projectId, correction.projectId))
              .where(and(eq(ragSnapshot.id, id), isNull(correction.featureId)))
              .orderBy(asc(correction.createdAt))
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
                    change: row.cardChange,
                    title: row.cardTitle,
                    unreferencedStatements: row.unreferencedStatements,
                    // A verification of an older version is outdated.
                    issues: row.verifiedVersion !== null && row.verifiedVersion === row.cardVersion ? row.issues : null
                  }
          })),
          orphanCorrections: orphans.map((row) => correctionView(row.correction))
        })
      }),

      saveCard: (id, newCard, provenance) =>
        query("knowledge.saveCard", () =>
          db.transaction(async (tx) => {
            // Versions continue across regenerations of the same feature's card, and across versions of the code.
            const [previous] = await tx
              .select({ version: card.version })
              .from(card)
              .where(eq(card.featureId, newCard.featureId))
            const version = Math.max(previous?.version ?? 0, newCard.baseVersion ?? 0) + 1
            await tx.delete(card).where(eq(card.featureId, newCard.featureId))
            const cardId = randomUUID()
            await tx.insert(card).values({
              id: cardId,
              snapshotId: id,
              featureId: newCard.featureId,
              status: newCard.status,
              change: newCard.change ?? null,
              title: newCard.content.title,
              summary: newCard.content.summary,
              content: newCard.content,
              sourceRevision: newCard.sourceRevision,
              version,
              unreferencedStatements: newCard.unreferencedStatements,
              promptVersion: provenance.promptVersion,
              model: provenance.model
            })
            for (const chunk of chunks(newCard.references, INSERT_CHUNK)) {
              await tx.insert(cardReference).values(chunk.map((reference) => ({ cardId, ...reference })))
            }
            return version
          })
        ),

      getCard: Effect.fnUntraced(function* (id, cardId) {
        const rows = yield* query("knowledge.getCard", () =>
          db
            .select({ card, feature, verification: cardVerification })
            .from(card)
            .innerJoin(feature, eq(feature.id, card.featureId))
            .leftJoin(cardVerification, eq(cardVerification.cardId, card.id))
            .where(and(eq(card.snapshotId, id), eq(card.id, cardId)))
        )
        const row = rows[0]
        if (row === undefined) return yield* new NotFoundError({ entity: "card", id: cardId })
        const corrections = yield* query("knowledge.cardCorrections", () =>
          db
            .select()
            .from(correction)
            .where(eq(correction.featureId, row.feature.id))
            .orderBy(asc(correction.createdAt))
        )
        const v = row.verification
        return yield* decodeCard({
          id: row.card.id,
          feature: {
            id: row.feature.id,
            name: row.feature.name,
            description: row.feature.description,
            files: row.feature.files,
            symbols: row.feature.symbols
          },
          status: row.card.status,
          change: row.card.change,
          content: row.card.content,
          sourceRevision: row.card.sourceRevision,
          version: row.card.version,
          unreferencedStatements: row.card.unreferencedStatements,
          model: row.card.model,
          createdAt: row.card.createdAt,
          updatedAt: row.card.updatedAt,
          reviewedBy: row.card.reviewedBy,
          reviewedAt: row.card.reviewedAt,
          verification:
            v === null
              ? null
              : {
                  cardVersion: v.cardVersion,
                  verifiedAt: v.verifiedAt,
                  model: v.model,
                  statements: v.statements,
                  missing: v.missing,
                  missingProbability: v.missingProbability,
                  missingSuspected: v.missingSuspected,
                  issues: v.issues
                },
          corrections: corrections.map(correctionView)
        })
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

      deleteProject: (projectId) =>
        query("knowledge.deleteProject", () =>
          db.transaction(async (tx) => {
            // Everything else cascades from rag.snapshot; corrections and test questions belong to the project.
            await tx.delete(ragSnapshot).where(eq(ragSnapshot.projectId, projectId))
            await tx.delete(correction).where(eq(correction.projectId, projectId))
            await tx.delete(testQuestion).where(eq(testQuestion.projectId, projectId))
          })
        ),

      cardsToVerify: (id) =>
        query("knowledge.cardsToVerify", () =>
          db
            .select({ id: card.id })
            .from(card)
            .leftJoin(cardVerification, eq(cardVerification.cardId, card.id))
            .where(
              and(
                eq(card.snapshotId, id),
                ne(card.status, "excluded"),
                or(isNull(cardVerification.cardId), lt(cardVerification.cardVersion, card.version))
              )
            )
            .orderBy(asc(card.createdAt))
        ).pipe(Effect.map((rows) => rows.map((row) => row.id))),

      saveVerification: (id, cardId, verification, provenance) =>
        query("knowledge.saveVerification", () =>
          db.transaction(async (tx) => {
            const values = {
              cardVersion: verification.cardVersion,
              statements: verification.statements,
              missing: verification.missing,
              missingProbability: verification.missingProbability,
              missingSuspected: verification.missingSuspected,
              issues: verification.issues,
              promptVersion: provenance.promptVersion,
              model: provenance.model,
              verifiedAt: new Date()
            }
            await tx
              .insert(cardVerification)
              .values({ cardId, ...values })
              .onConflictDoUpdate({ target: cardVerification.cardId, set: values })
            // Only automatic states follow the verification; review decisions are kept.
            await tx
              .update(card)
              .set({ status: verification.issues > 0 ? "flagged" : "generated" })
              .where(and(eq(card.snapshotId, id), eq(card.id, cardId), inArray(card.status, ["generated", "flagged"])))
          })
        ),

      editCard: (id, cardId, edit, reviewer) =>
        query("knowledge.editCard", () =>
          db.transaction(async (tx) => {
            const updated = await tx
              .update(card)
              .set({
                content: edit.content,
                title: edit.content.title,
                summary: edit.content.summary,
                unreferencedStatements: edit.unreferencedStatements,
                version: sql`${card.version} + 1`,
                status: "in_review",
                reviewedBy: reviewer.name,
                reviewedAt: new Date()
              })
              .where(and(eq(card.snapshotId, id), eq(card.id, cardId)))
              .returning({ id: card.id })
            if (updated.length === 0) return false
            await tx.delete(cardReference).where(eq(cardReference.cardId, cardId))
            for (const chunk of chunks(edit.references, INSERT_CHUNK)) {
              await tx.insert(cardReference).values(chunk.map((reference) => ({ cardId, ...reference })))
            }
            return true
          })
        ).pipe(
          Effect.flatMap((found) =>
            found ? Effect.void : Effect.fail(new NotFoundError({ entity: "card", id: cardId }))
          )
        ),

      setCardStatus: (id, cardId, status, reviewer) =>
        query("knowledge.setCardStatus", () =>
          db
            .update(card)
            .set({ status, reviewedBy: reviewer.name, reviewedAt: new Date() })
            .where(and(eq(card.snapshotId, id), eq(card.id, cardId)))
            .returning({ id: card.id })
        ).pipe(
          Effect.flatMap((rows) =>
            rows.length > 0 ? Effect.void : Effect.fail(new NotFoundError({ entity: "card", id: cardId }))
          )
        ),

      addCorrection: (input) =>
        query("knowledge.addCorrection", () =>
          db
            .insert(correction)
            .values({
              id: randomUUID(),
              projectId: input.projectId,
              featureId: input.featureId,
              featureName: input.featureName,
              featureKey: featureKey(input.featureName),
              text: input.text,
              authorId: input.author.id,
              authorName: input.author.name
            })
            .returning()
        ).pipe(Effect.flatMap((rows) => decodeCorrection(correctionView(rows[0]!)))),

      corrections: (id) =>
        query("knowledge.corrections", () =>
          db
            .select({ correction })
            .from(correction)
            .innerJoin(feature, eq(feature.id, correction.featureId))
            .where(eq(feature.snapshotId, id))
            .orderBy(asc(correction.createdAt))
        ).pipe(
          Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeCorrection(correctionView(row.correction))))
        ),

      markCorrectionsApplied: (ids, cardVersion) =>
        ids.length === 0
          ? Effect.void
          : query("knowledge.markCorrectionsApplied", () =>
              db
                .update(correction)
                .set({ appliedVersion: cardVersion })
                .where(inArray(correction.id, [...ids]))
            ).pipe(Effect.asVoid),

      reattachCorrections: (id, projectId, options) =>
        query("knowledge.reattachCorrections", () =>
          db.transaction(async (tx) => {
            const features = await tx
              .select({ id: feature.id, name: feature.name })
              .from(feature)
              .where(eq(feature.snapshotId, id))
            const byKey = new Map(features.map((f) => [featureKey(f.name), f.id]))
            const corrections = await tx
              .select({ id: correction.id, featureKey: correction.featureKey })
              .from(correction)
              .where(eq(correction.projectId, projectId))
            for (const row of corrections) {
              // Re-attached corrections are pending again (the new card has not applied them yet), except in an
              // incremental update: unchanged cards are copied with the corrections they applied.
              await tx
                .update(correction)
                .set({
                  featureId: byKey.get(row.featureKey) ?? null,
                  ...(options?.keepApplied === true ? {} : { appliedVersion: null })
                })
                .where(eq(correction.id, row.id))
            }
          })
        ),

      copyFileSummaries: (id, baseId, paths, provenance) =>
        Effect.forEach(chunks(paths, INSERT_CHUNK), (group) =>
          query("knowledge.copyFileSummaries", () =>
            db.transaction(async (tx) => {
              const copied = await tx.execute<{ path: string }>(sql`
                insert into ${fileSummary} (snapshot_id, path, language, content_hash, summary, parts, prompt_version, model)
                select ${id}, path, language, content_hash, summary, parts, prompt_version, model
                from ${fileSummary}
                where ${and(
                  eq(fileSummary.snapshotId, baseId),
                  inArray(fileSummary.path, [...group]),
                  eq(fileSummary.model, provenance.model),
                  eq(fileSummary.promptVersion, provenance.promptVersion)
                )}
                on conflict (snapshot_id, path) do nothing
                returning path`)
              const done = copied.rows.map((row) => row.path)
              if (done.length > 0) {
                await tx.execute(sql`
                  insert into ${symbolSummary} (snapshot_id, path, qualified_name, kind, start_line, end_line, summary)
                  select ${id}, path, qualified_name, kind, start_line, end_line, summary
                  from ${symbolSummary}
                  where ${and(eq(symbolSummary.snapshotId, baseId), inArray(symbolSummary.path, done))}`)
              }
              return done
            })
          )
        ).pipe(Effect.map((groups) => groups.flat())),

      copyModuleSummaries: (id, baseId, paths, provenance) =>
        Effect.forEach(
          chunks(paths, INSERT_CHUNK),
          (group) =>
            query("knowledge.copyModuleSummaries", () =>
              db.execute(sql`
                insert into ${moduleSummary} (snapshot_id, path, depth, summary, file_count, prompt_version, model)
                select ${id}, path, depth, summary, file_count, prompt_version, model
                from ${moduleSummary}
                where ${and(
                  eq(moduleSummary.snapshotId, baseId),
                  inArray(moduleSummary.path, [...group]),
                  eq(moduleSummary.model, provenance.model),
                  eq(moduleSummary.promptVersion, provenance.promptVersion)
                )}
                on conflict (snapshot_id, path) do nothing`)
            ),
          { discard: true }
        ),

      copyCard: (id, input) =>
        query("knowledge.copyCard", () =>
          db.transaction(async (tx) => {
            const [source] = await tx.select().from(card).where(eq(card.id, input.cardId))
            if (source === undefined) return undefined
            const cardId = randomUUID()
            // Idempotent: a previous attempt may have copied it already.
            await tx.delete(card).where(eq(card.featureId, input.featureId))
            await tx.insert(card).values({
              ...source,
              id: cardId,
              snapshotId: id,
              featureId: input.featureId,
              status: input.status ?? source.status,
              change: "kept",
              createdAt: new Date(),
              updatedAt: source.updatedAt
            })
            await tx.execute(sql`
              insert into ${cardReference} (card_id, section, item_index, claim, path, start_line, end_line)
              select ${cardId}, section, item_index, claim, path, start_line, end_line
              from ${cardReference} where ${eq(cardReference.cardId, source.id)}`)
            await tx.execute(sql`
              insert into ${cardVerification}
                (card_id, card_version, statements, missing, missing_probability, missing_suspected, issues,
                 prompt_version, model, verified_at)
              select ${cardId}, card_version, statements, missing, missing_probability, missing_suspected, issues,
                prompt_version, model, verified_at
              from ${cardVerification} where ${eq(cardVerification.cardId, source.id)}`)
            // Same text, same vectors: the copied card does not need to be embedded again.
            await tx.execute(sql`
              insert into ${indexChunk}
                (snapshot_id, card_id, card_version, section, text, embedding, dimensions, model, format_version)
              select ${id}, ${cardId}, card_version, section, text, embedding, dimensions, model, format_version
              from ${indexChunk} where ${eq(indexChunk.cardId, source.id)}`)
            return cardId
          })
        ).pipe(
          Effect.flatMap((cardId) =>
            cardId === undefined
              ? Effect.fail(new NotFoundError({ entity: "card", id: input.cardId }))
              : Effect.succeed(cardId)
          )
        ),

      changeCounts: (id) =>
        query("knowledge.changeCounts", () =>
          db
            .select({ change: card.change, total: count() })
            .from(card)
            .where(eq(card.snapshotId, id))
            .groupBy(card.change)
        ).pipe(
          Effect.map((rows) => {
            const of = (change: string) => rows.find((row) => row.change === change)?.total ?? 0
            return { kept: of("kept"), updated: of("updated"), created: of("created") }
          })
        ),

      deleteSnapshots: (ids) =>
        ids.length === 0
          ? Effect.void
          : query("knowledge.deleteSnapshots", () =>
              // Everything else cascades; corrections and test questions only lose their feature (set null).
              db.delete(ragSnapshot).where(inArray(ragSnapshot.id, [...ids]))
            ).pipe(Effect.asVoid)
    })
  })
)
