import { IndexRepository } from "@code-to-rag/core"
import { and, asc, count, countDistinct, desc, eq, inArray, max, ne, sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Database, query } from "./client.ts"
import { decodeCardContent, decodeCardStatus, decodeIndexStatus } from "./rows.ts"
import { card, chunk, feature } from "./schema/rag.ts"

const vectorLiteral = (values: ReadonlyArray<number>) => `[${values.join(",")}]`

/** Embedding index in `rag.chunk`: exact (sequential) vector search per snapshot plus full-text search. */
export const IndexRepositoryLive = Layer.effect(
  IndexRepository,
  Effect.gen(function* () {
    const { db } = yield* Database

    /** Chunks of the current version of cards in scope, embedded with the given model. */
    const searchable = (id: string, model: string, approvedOnly: boolean) =>
      and(
        eq(chunk.snapshotId, id),
        eq(chunk.model, model),
        eq(chunk.cardVersion, card.version),
        approvedOnly ? eq(card.status, "approved") : ne(card.status, "excluded")
      )

    return IndexRepository.of({
      cardsToIndex: Effect.fnUntraced(function* (id, meta) {
        const rows = yield* query("index.cardsToIndex", () =>
          db
            .select({ cardId: card.id, version: card.version, featureName: feature.name, content: card.content })
            .from(card)
            .innerJoin(feature, eq(feature.id, card.featureId))
            .where(
              and(
                eq(card.snapshotId, id),
                ne(card.status, "excluded"),
                sql`not exists (
                  select 1 from ${chunk}
                  where ${chunk.cardId} = ${card.id} and ${chunk.cardVersion} = ${card.version}
                    and ${chunk.model} = ${meta.model} and ${chunk.formatVersion} = ${meta.formatVersion}
                )`
              )
            )
            .orderBy(asc(feature.position))
        )
        return yield* Effect.forEach(rows, (row) =>
          decodeCardContent(row.content).pipe(Effect.map((content) => ({ ...row, content })))
        )
      }),

      saveChunks: (id, target, chunks, meta) =>
        query("index.saveChunks", () =>
          db.transaction(async (tx) => {
            // Serialises concurrent indexing jobs on the same card.
            await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${target.cardId}::text))`)
            const [current] = await tx
              .select({ version: card.version })
              .from(card)
              .where(and(eq(card.snapshotId, id), eq(card.id, target.cardId)))
              .for("share")
            // Edited or replaced meanwhile: the next round indexes the new version.
            if (current?.version !== target.version) return
            await tx.delete(chunk).where(eq(chunk.cardId, target.cardId))
            if (chunks.length === 0) return
            await tx.insert(chunk).values(
              chunks.map((c) => ({
                snapshotId: id,
                cardId: target.cardId,
                cardVersion: target.version,
                section: c.section,
                text: c.text,
                embedding: c.embedding,
                dimensions: c.embedding.length,
                model: meta.model,
                formatVersion: meta.formatVersion
              }))
            )
          })
        ),

      clear: (id) => query("index.clear", () => db.delete(chunk).where(eq(chunk.snapshotId, id))).pipe(Effect.asVoid),

      status: Effect.fnUntraced(function* (id, meta) {
        const [cards, indexed, chunks] = yield* Effect.all([
          query("index.statusCards", () =>
            db
              .select({
                indexable: sql<number>`count(*) filter (where ${card.status} <> 'excluded')`.mapWith(Number),
                approved: sql<number>`count(*) filter (where ${card.status} = 'approved')`.mapWith(Number)
              })
              .from(card)
              .where(eq(card.snapshotId, id))
          ),
          meta === undefined
            ? Effect.succeed([{ cards: 0 }])
            : query("index.statusIndexed", () =>
                db
                  .select({ cards: countDistinct(chunk.cardId) })
                  .from(chunk)
                  .innerJoin(card, eq(card.id, chunk.cardId))
                  .where(
                    and(
                      eq(chunk.snapshotId, id),
                      eq(chunk.model, meta.model),
                      eq(chunk.formatVersion, meta.formatVersion),
                      eq(chunk.cardVersion, card.version),
                      ne(card.status, "excluded")
                    )
                  )
              ),
          meta === undefined
            ? Effect.succeed([{ total: 0, indexedAt: null }])
            : query("index.statusChunks", () =>
                db
                  .select({ total: count(), indexedAt: max(chunk.createdAt) })
                  .from(chunk)
                  .where(and(eq(chunk.snapshotId, id), eq(chunk.model, meta.model)))
              )
        ])
        return yield* decodeIndexStatus({
          model: meta?.model ?? null,
          indexableCards: cards[0]?.indexable ?? 0,
          approvedCards: cards[0]?.approved ?? 0,
          indexedCards: indexed[0]?.cards ?? 0,
          chunks: chunks[0]?.total ?? 0,
          indexedAt: chunks[0]?.indexedAt ?? null
        })
      }),

      search: Effect.fnUntraced(function* (id, search) {
        const scope = searchable(id, search.model, search.approvedOnly)
        const vector = query("index.searchVector", () =>
          db
            .select({ cardId: chunk.cardId, section: chunk.section })
            .from(chunk)
            .innerJoin(card, eq(card.id, chunk.cardId))
            .where(and(scope, eq(chunk.dimensions, search.embedding.length)))
            .orderBy(sql`${chunk.embedding} <=> ${vectorLiteral(search.embedding)}::vector`)
            .limit(search.limit)
        )
        // Any of the words: the question may be in another language than the cards. websearch_to_tsquery never
        // fails on unusual input (to_tsquery raises syntax errors).
        const tsquery = sql`websearch_to_tsquery('simple', ${search.terms.join(" or ")})`
        const text =
          search.terms.length === 0
            ? Effect.succeed([])
            : query("index.searchText", () =>
                db
                  .select({ cardId: chunk.cardId, section: chunk.section })
                  .from(chunk)
                  .innerJoin(card, eq(card.id, chunk.cardId))
                  .where(and(scope, sql`${chunk.searchVector} @@ ${tsquery}`))
                  .orderBy(desc(sql`ts_rank_cd(${chunk.searchVector}, ${tsquery})`), asc(chunk.id))
                  .limit(search.limit)
              )
        const [vectorHits, textHits] = yield* Effect.all([
          search.embedding.length === 0 ? Effect.succeed([]) : vector,
          text
        ])
        return { vector: vectorHits, text: textHits }
      }),

      cards: Effect.fnUntraced(function* (id, cardIds) {
        if (cardIds.length === 0) return []
        const rows = yield* query("index.cards", () =>
          db
            .select({
              cardId: card.id,
              featureId: card.featureId,
              featureName: feature.name,
              title: card.title,
              status: card.status,
              content: card.content
            })
            .from(card)
            .innerJoin(feature, eq(feature.id, card.featureId))
            .where(and(eq(card.snapshotId, id), inArray(card.id, [...cardIds])))
        )
        const byId = new Map(rows.map((row) => [row.cardId, row]))
        return yield* Effect.forEach(
          cardIds.flatMap((cardId) => {
            const row = byId.get(cardId)
            return row === undefined ? [] : [row]
          }),
          (row) =>
            Effect.all({ content: decodeCardContent(row.content), status: decodeCardStatus(row.status) }).pipe(
              Effect.map((decoded) => ({ ...row, ...decoded }))
            )
        )
      })
    })
  })
)
