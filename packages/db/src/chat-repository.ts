import { ChatRepository, NotFoundError } from "@code-to-rag/core"
import { and, asc, desc, eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { randomUUID } from "node:crypto"
import { Database, query } from "./client.ts"
import { decodeChatConversation, decodeChatMessage } from "./rows.ts"
import { chatConversation, chatMessage } from "./schema/app.ts"

/** Conversations listed per project. */
const MAX_CONVERSATIONS = 50

const conversationView = (row: typeof chatConversation.$inferSelect) =>
  decodeChatConversation({
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  })

const messageView = (row: typeof chatMessage.$inferSelect) =>
  decodeChatMessage({
    id: row.id,
    role: row.role,
    content: row.content,
    status: row.status,
    sources: row.sources,
    citations: row.citations,
    snapshotId: row.snapshotId,
    model: row.model,
    createdAt: row.createdAt
  })

export const ChatRepositoryLive = Layer.effect(
  ChatRepository,
  Effect.gen(function* () {
    const { db } = yield* Database

    return ChatRepository.of({
      conversations: Effect.fnUntraced(function* (projectId, userId) {
        const rows = yield* query("chat.conversations", () =>
          db
            .select()
            .from(chatConversation)
            .where(and(eq(chatConversation.projectId, projectId), eq(chatConversation.userId, userId)))
            .orderBy(desc(chatConversation.updatedAt))
            .limit(MAX_CONVERSATIONS)
        )
        return yield* Effect.forEach(rows, conversationView)
      }),

      createConversation: Effect.fnUntraced(function* (input) {
        const rows = yield* query("chat.createConversation", () =>
          db
            .insert(chatConversation)
            .values({ id: randomUUID(), projectId: input.projectId, userId: input.userId, title: input.title })
            .returning()
        )
        return yield* conversationView(rows[0]!)
      }),

      getConversation: Effect.fnUntraced(function* (conversationId, userId) {
        const conversations = yield* query("chat.getConversation", () =>
          db
            .select()
            .from(chatConversation)
            .where(and(eq(chatConversation.id, conversationId), eq(chatConversation.userId, userId)))
        )
        const row = conversations[0]
        if (row === undefined) return yield* new NotFoundError({ entity: "conversation", id: conversationId })
        const messages = yield* query("chat.messages", () =>
          db
            .select()
            .from(chatMessage)
            .where(eq(chatMessage.conversationId, conversationId))
            .orderBy(asc(chatMessage.createdAt))
        )
        return {
          conversation: yield* conversationView(row),
          messages: yield* Effect.forEach(messages, messageView)
        }
      }),

      addMessage: Effect.fnUntraced(function* (conversationId, message) {
        const rows = yield* query("chat.addMessage", () =>
          db.transaction(async (tx) => {
            const inserted = await tx
              .insert(chatMessage)
              .values({
                id: randomUUID(),
                conversationId,
                role: message.role,
                content: message.content,
                status: message.status,
                sources: message.sources,
                citations: [...message.citations],
                snapshotId: message.snapshotId,
                model: message.model
              })
              .returning()
            await tx
              .update(chatConversation)
              .set({ updatedAt: new Date() })
              .where(eq(chatConversation.id, conversationId))
            return inserted
          })
        )
        return yield* messageView(rows[0]!)
      }),

      deleteConversation: (conversationId, userId) =>
        query("chat.deleteConversation", () =>
          db
            .delete(chatConversation)
            .where(and(eq(chatConversation.id, conversationId), eq(chatConversation.userId, userId)))
            .returning({ id: chatConversation.id })
        ).pipe(
          Effect.flatMap((rows) =>
            rows.length > 0
              ? Effect.void
              : Effect.fail(new NotFoundError({ entity: "conversation", id: conversationId }))
          )
        )
    })
  })
)
