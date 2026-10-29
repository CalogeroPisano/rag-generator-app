/**
 * RAG chat: retrieve the cards relevant to a question, give them to the chat
 * model as numbered sources and stream its answer, which cites them by number.
 * Shared by the web chat and the test runs.
 */
import { CHAT_ANSWER, chatInstructions, citedSources, renderCardText, renderChatQuestion } from "../prompts/chat.ts"
import { estimateTokens, truncate } from "../prompts/format.ts"
import { EmbeddingModel, LanguageModel, type ModelCallContext } from "../../ports/outbound/models.ts"
import { Effect } from "effect"
import { AppConfig } from "../config.ts"
import type { ChatConversation, ChatMessage, ChatSource, ProjectId, SnapshotId, UserId } from "../../domain/model.ts"
import { InvalidInputError, NotFoundError } from "../../domain/errors.ts"
import {
  ChatRepository,
  type ContextCard,
  IndexRepository,
  ProjectRepository
} from "../../ports/outbound/repositories.ts"
import { type RankedCard, retrieveCards } from "./retrieval.ts"

/** Earlier exchanges of a conversation sent with a question, and their length. */
const MAX_HISTORY_TURNS = 3
const MAX_HISTORY_CHARS = 1500
/** Tokens kept free for the chat template and estimation errors. */
const SAFETY_TOKENS = 512
const MAX_TITLE_CHARS = 80

export interface ChatTurn {
  readonly question: string
  readonly answer: string
}

export interface PreparedAnswer {
  /** Retrieved cards, best first (before the context budget). */
  readonly ranked: ReadonlyArray<RankedCard>
  /** Cards given to the model, numbered from 1 in this order. */
  readonly sources: ReadonlyArray<ContextCard>
  readonly messages: ReadonlyArray<{ readonly role: "user" | "assistant"; readonly content: string }>
}

const allowed = (card: ContextCard, approvedOnly: boolean) =>
  approvedOnly ? card.status === "approved" : card.status !== "excluded"

/**
 * Retrieves the sources of a question and builds the messages within the
 * model's context window. `carryOver` cards (cited by the previous answer)
 * follow the retrieved ones, so that follow-up questions keep their context.
 */
export const prepareAnswer = Effect.fn("rag.prepareAnswer")(function* (
  snapshotId: SnapshotId,
  question: string,
  options: {
    readonly approvedOnly: boolean
    readonly history: ReadonlyArray<ChatTurn>
    readonly carryOver: ReadonlyArray<string>
    readonly context: ModelCallContext
  }
) {
  const config = yield* AppConfig
  const model = yield* LanguageModel
  const index = yield* IndexRepository
  const ranked = yield* retrieveCards(snapshotId, question, {
    approvedOnly: options.approvedOnly,
    limit: config.rag.topCards,
    candidates: config.rag.candidates,
    context: options.context
  })
  const ids = [...new Set([...ranked.map((card) => card.cardId), ...options.carryOver])]
  const cards = (yield* index.cards(snapshotId, ids)).filter((card) => allowed(card, options.approvedOnly))

  const history = options.history.slice(-MAX_HISTORY_TURNS).flatMap((turn) => [
    { role: "user" as const, content: truncate(turn.question, MAX_HISTORY_CHARS) },
    { role: "assistant" as const, content: truncate(turn.answer, MAX_HISTORY_CHARS) }
  ])
  let budget =
    model.contextTokens -
    model.chatMaxOutputTokens -
    estimateTokens(chatInstructions) -
    estimateTokens(history.map((message) => message.content).join("\n")) -
    estimateTokens(renderChatQuestion({ sources: [], question })) -
    SAFETY_TOKENS

  const sources: Array<ContextCard> = []
  const texts: Array<string> = []
  for (const card of cards) {
    let text = renderCardText({ featureName: card.featureName, card: card.content })
    const cost = estimateTokens(text) + 4
    if (cost > budget) {
      // The best card is always given, shortened if needed; the others only when they fit.
      if (sources.length > 0 || budget < 200) break
      text = truncate(text, budget * 3)
    }
    sources.push(card)
    texts.push(text)
    budget -= estimateTokens(text) + 4
  }
  return {
    ranked,
    sources,
    messages: [...history, { role: "user" as const, content: renderChatQuestion({ sources: texts, question }) }]
  } satisfies PreparedAnswer
})

/** Asks the chat model; `citations` are the valid source numbers cited by the answer. */
export const generateAnswer = Effect.fn("rag.generateAnswer")(function* (
  prepared: PreparedAnswer,
  context: ModelCallContext,
  onDelta?: (delta: string) => void
) {
  const model = yield* LanguageModel
  const answer = yield* model.generateText({
    prompt: CHAT_ANSWER,
    context,
    instructions: chatInstructions,
    messages: prepared.messages,
    onDelta
  })
  return { text: answer.text.trim(), citations: citedSources(answer.text, prepared.sources.length) }
})

const toSource = (card: ContextCard): ChatSource => ({
  cardId: card.cardId,
  featureId: card.featureId,
  featureName: card.featureName,
  title: card.title,
  status: card.status
})

export type ChatEvent =
  | { readonly type: "conversation"; readonly conversation: ChatConversation }
  | { readonly type: "sources"; readonly sources: ReadonlyArray<ChatSource> }
  | { readonly type: "delta"; readonly text: string }
  | { readonly type: "done"; readonly message: ChatMessage }
  /** The model failed after the question was stored: the partial answer is kept as a failed message. */
  | { readonly type: "error"; readonly message: string }

/** Exchanges of a conversation usable as history: a question followed by a complete answer. */
const turnsOf = (messages: ReadonlyArray<ChatMessage>): Array<ChatTurn> => {
  const turns: Array<ChatTurn> = []
  messages.forEach((message, i) => {
    const next = messages[i + 1]
    if (message.role === "user" && next?.role === "assistant" && next.status === "complete") {
      turns.push({ question: message.content, answer: next.content })
    }
  })
  return turns
}

/**
 * One chat exchange on the latest snapshot of a project: stores the question,
 * streams the answer through `emit` and stores it with its sources. A client
 * that goes away interrupts the model call; the partial answer is kept.
 */
export const askQuestion = Effect.fn("askQuestion")(function* (
  input: {
    readonly projectId: ProjectId
    readonly userId: UserId
    readonly conversationId: string | null
    readonly question: string
    readonly approvedOnly: boolean
  },
  emit: (event: ChatEvent) => void
) {
  const projects = yield* ProjectRepository
  const chat = yield* ChatRepository
  const model = yield* LanguageModel
  const embeddings = yield* EmbeddingModel
  const question = input.question.trim()
  if (question === "") return yield* new InvalidInputError({ message: "Scrivi una domanda" })
  if (model.modelId === undefined) {
    return yield* new InvalidInputError({ message: "Modello IA non configurato (AI_MODEL)" })
  }
  if (embeddings.modelId === undefined) {
    return yield* new InvalidInputError({ message: "Modello di embedding non configurato (EMBEDDING_MODEL)" })
  }
  // The version in use: a new version answers only once its update is complete.
  const { currentSnapshot: snapshot } = yield* projects.get(input.projectId)
  if (snapshot === null || snapshot.understandingStatus !== "ready") {
    return yield* new InvalidInputError({ message: "Le schede del progetto non sono ancora pronte" })
  }

  let messages: ReadonlyArray<ChatMessage> = []
  let conversation: ChatConversation
  if (input.conversationId === null) {
    conversation = yield* chat.createConversation({
      projectId: input.projectId,
      userId: input.userId,
      title: truncate(question.replace(/\s+/g, " "), MAX_TITLE_CHARS)
    })
  } else {
    const view = yield* chat.getConversation(input.conversationId, input.userId)
    if (view.conversation.projectId !== input.projectId) {
      return yield* new NotFoundError({ entity: "conversation", id: input.conversationId })
    }
    conversation = view.conversation
    messages = view.messages
  }
  emit({ type: "conversation", conversation })

  const previous = messages.findLast((message) => message.role === "assistant" && message.status === "complete")
  const carryOver = (previous?.citations ?? []).flatMap((n) => {
    const source = previous?.sources[n - 1]
    return source === undefined ? [] : [source.cardId]
  })
  yield* chat.addMessage(conversation.id, {
    role: "user",
    content: question,
    status: "complete",
    sources: [],
    citations: [],
    snapshotId: snapshot.id,
    model: null
  })

  const context = { phase: "chat", snapshotId: snapshot.id }
  let partial = ""
  let sources: ReadonlyArray<ChatSource> = []
  const saveAssistant = (content: string, status: ChatMessage["status"], citations: ReadonlyArray<number>) =>
    chat.addMessage(conversation.id, {
      role: "assistant",
      content,
      status,
      sources,
      citations,
      snapshotId: snapshot.id,
      model: model.modelId ?? null
    })

  return yield* Effect.gen(function* () {
    const prepared = yield* prepareAnswer(snapshot.id, question, {
      approvedOnly: input.approvedOnly,
      history: turnsOf(messages),
      carryOver,
      context
    })
    sources = prepared.sources.map(toSource)
    emit({ type: "sources", sources })
    const answer = yield* generateAnswer(prepared, context, (delta) => {
      partial += delta
      emit({ type: "delta", text: delta })
    })
    const message = yield* saveAssistant(answer.text, "complete", answer.citations)
    emit({ type: "done", message })
  }).pipe(
    Effect.catchTag("AiError", (error) =>
      saveAssistant(partial, "failed", []).pipe(
        Effect.andThen(Effect.sync(() => emit({ type: "error", message: error.message })))
      )
    ),
    Effect.onInterrupt(() =>
      partial === "" ? Effect.void : saveAssistant(partial, "interrupted", []).pipe(Effect.ignore)
    )
  )
})
