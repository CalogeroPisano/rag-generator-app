/**
 * Writing and verifying one card. Shared by the `generate-cards` and
 * `verify-cards` phases of the understanding and by the card jobs of the
 * review (regenerate, correct, verify).
 */
import { CARD, cardInstructions, renderCard, renderCardExcerpt } from "../prompts/card.ts"
import { estimateTokens } from "../prompts/format.ts"
import {
  CARD_MISSING,
  CARD_VERIFY,
  CardMissingOutput,
  cardMissingInstructions,
  cardStatements,
  renderCardVerify,
  renderStatementState,
  statementQuestion
} from "../prompts/verify.ts"
import { AppConfig } from "../config.ts"
import { CardContent, type StatementVerdict } from "../../domain/card.ts"
import { DecisionModel, type DecisionQuestion, LanguageModel } from "../../ports/outbound/models.ts"
import { Effect } from "effect"
import type { FeatureSymbol, SnapshotId } from "../../domain/model.ts"
import type { Declaration, NewVerification } from "../../ports/outbound/repositories.ts"
import { KnowledgeRepository, UnderstandingRepository } from "../../ports/outbound/repositories.ts"
import { buildCardExcerpts, citedExcerpts } from "./excerpts.ts"
import { type CheckedCard, checkReferenceList, checkReferences } from "./references.ts"
import { chunks, inputBudget } from "./shared.ts"

export interface CardFeature {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly files: ReadonlyArray<string>
  readonly symbols: ReadonlyArray<FeatureSymbol>
}

/** Snapshot data every card needs; loaded once per job. */
export interface CardSources {
  readonly summaries: ReadonlyMap<string, string>
  readonly declarations: ReadonlyArray<Declaration>
}

export interface CallContext {
  readonly phase: string
  readonly jobId: string
  readonly snapshotId: SnapshotId
}

/** Rough cost of listing a file that does not fit (path + summary). */
const OMITTED_FILE_TOKENS = 40

export const loadCardSources = (snapshotId: SnapshotId) =>
  Effect.gen(function* () {
    const knowledge = yield* KnowledgeRepository
    const understanding = yield* UnderstandingRepository
    const summaries = new Map((yield* knowledge.fileSummaries(snapshotId)).map((s) => [s.path, s.summary]))
    const declarations = yield* understanding.declarations(snapshotId)
    return { summaries, declarations } satisfies CardSources
  })

const excerptsFor = Effect.fnUntraced(function* (
  context: CallContext,
  feature: CardFeature,
  sources: CardSources,
  budget: number,
  extraRanges: ReadonlyArray<{ readonly path: string; readonly startLine: number; readonly endLine: number }> = []
) {
  const understanding = yield* UnderstandingRepository
  const files = yield* understanding.loadFiles(context.snapshotId, feature.files)
  return buildCardExcerpts({
    files,
    summaries: sources.summaries,
    featureSymbols: feature.symbols,
    declarations: sources.declarations.filter((d) => feature.files.includes(d.path)),
    extraRanges,
    maxTokens: Math.max(512, budget - feature.files.length * OMITTED_FILE_TOKENS)
  })
})

/**
 * Writes a card for a feature, or updates `current` when given (correction, or
 * new code in an incremental update). Reviewer corrections go into the prompt. Returns undefined when no file of the feature
 * can be shown (nothing to write from).
 */
export const writeCard = Effect.fnUntraced(function* (
  context: CallContext,
  feature: CardFeature,
  sources: CardSources,
  options: {
    readonly current: CardContent | null
    readonly corrections: ReadonlyArray<string>
    /** Incremental update: files of the feature that changed since `current` was written. */
    readonly changedFiles?: ReadonlyArray<string> | undefined
  }
) {
  const model = yield* LanguageModel
  const header = estimateTokens(
    renderCard({
      feature,
      excerpts: [],
      omitted: [],
      corrections: options.corrections,
      current: options.current,
      changedFiles: options.changedFiles
    })
  )
  const { excerpts, omitted, shown } = yield* excerptsFor(
    context,
    feature,
    sources,
    inputBudget(model, cardInstructions) - header
  )
  if (excerpts.length === 0) return undefined
  const answer = yield* model.generateObject({
    prompt: CARD,
    context,
    instructions: cardInstructions,
    input: renderCard({
      feature,
      excerpts: excerpts.map(renderCardExcerpt),
      omitted,
      corrections: options.corrections,
      current: options.current,
      changedFiles: options.changedFiles
    }),
    schema: CardContent
  })
  return checkReferences(answer, shown) satisfies CheckedCard
})

/** Room left for the question texts and the request envelope in a decision request. */
const DECISION_SAFETY_TOKENS = 256

/** A decision request: one state and the questions asked about it. */
interface DecisionGroup {
  readonly state: string
  readonly questions: ReadonlyArray<readonly [string, DecisionQuestion]>
}

const questionTokens = (questions: ReadonlyArray<readonly [string, DecisionQuestion]>) =>
  questions.reduce(
    (sum, [, q]) => sum + estimateTokens(q.instructions + (q.criteria?.true ?? "") + (q.criteria?.false ?? "")),
    0
  )

/**
 * Verifies a card against the code of its feature.
 *
 * The decision model gives the probability that each statement is supported (verdict by threshold), without
 * generating text. It reads the state once per question, so the time grows with state size × questions: a statement
 * that cites code is asked about its cited lines only (statements citing the same lines share a request); statements
 * without references get the card and the code of the whole feature. The language model then lists what the code
 * shows and the card is missing (a decision model cannot write that list).
 */
export const verifyCard = Effect.fnUntraced(function* (
  context: CallContext,
  feature: CardFeature,
  sources: CardSources,
  card: { readonly content: CardContent; readonly version: number; readonly unreferencedStatements: number }
) {
  const decision = yield* DecisionModel
  const model = yield* LanguageModel
  const understanding = yield* UnderstandingRepository
  const thresholds = (yield* AppConfig).verification
  const statements = cardStatements(card.content)
  const cited = statements.flatMap((s) => s.cited)
  const budget = (questions: ReadonlyArray<readonly [string, DecisionQuestion]>, header: string) =>
    decision.contextTokens - estimateTokens(header) - questionTokens(questions) - DECISION_SAFETY_TOKENS
  const cardHeader = renderCardVerify({ feature, card: card.content, excerpts: [] })

  // Statements grouped by the lines they cite.
  const byCitation = new Map<string, Array<(typeof statements)[number]>>()
  for (const statement of statements) {
    const key = statement.cited.length === 0 ? "" : statement.references
    byCitation.set(key, [...(byCitation.get(key) ?? []), statement])
  }

  const groups: Array<DecisionGroup> = []
  const files = yield* understanding.loadFiles(context.snapshotId, feature.files)
  for (const [key, group] of byCitation) {
    if (key === "") continue
    for (const part of chunks(group, decision.maxQuestions)) {
      const questions = part.map((s) => [s.id, statementQuestion(s.text)] as const)
      const header = renderStatementState({ feature, excerpts: [] })
      const excerpts = citedExcerpts({ files, references: part[0]!.cited, maxTokens: budget(questions, header) })
      groups.push({ state: renderStatementState({ feature, excerpts: excerpts.map(renderCardExcerpt) }), questions })
    }
  }
  const unreferenced = chunks(
    (byCitation.get("") ?? []).map((s) => [s.id, statementQuestion(s.text)] as const),
    decision.maxQuestions
  )
  if (unreferenced.length > 0) {
    const { excerpts } = yield* excerptsFor(
      context,
      feature,
      sources,
      Math.min(...unreferenced.map((part) => budget(part, cardHeader))),
      cited
    )
    const state = renderCardVerify({ feature, card: card.content, excerpts: excerpts.map(renderCardExcerpt) })
    for (const part of unreferenced) groups.push({ state, questions: part })
  }

  const answers = new Map<string, number>()
  for (const group of groups) {
    const result = yield* decision.decide({
      prompt: CARD_VERIFY,
      context,
      state: group.state,
      questions: Object.fromEntries(group.questions)
    })
    for (const [name] of group.questions) {
      const probability = result[name]
      if (probability !== undefined) answers.set(name, probability)
    }
  }

  // Missing items: the language model reads the card next to the code of the whole feature.
  const { excerpts, shown } = yield* excerptsFor(
    context,
    feature,
    sources,
    inputBudget(model, cardMissingInstructions) - estimateTokens(cardHeader),
    cited
  )
  const answer = yield* model.generateObject({
    prompt: CARD_MISSING,
    context,
    instructions: cardMissingInstructions,
    input: renderCardVerify({ feature, card: card.content, excerpts: excerpts.map(renderCardExcerpt) }),
    schema: CardMissingOutput
  })
  const missing = answer.missing
    .filter((item) => item.text.trim() !== "")
    .map((item) => ({ ...item, text: item.text.trim(), references: checkReferenceList(item.references, shown) }))

  const verdictOf = (probability: number): StatementVerdict =>
    probability >= thresholds.supported ? "supported" : probability < thresholds.unsupported ? "unsupported" : "partial"
  const assessed = statements.map((statement) => {
    const probability = answers.get(statement.id)
    return probability === undefined
      ? { id: statement.id, verdict: "partial" as const, note: "Not assessed by the verifier." }
      : { id: statement.id, verdict: verdictOf(probability), note: "", probability }
  })
  const issues = assessed.filter((s) => s.verdict !== "supported").length + missing.length + card.unreferencedStatements
  return { cardVersion: card.version, statements: assessed, missing, issues } satisfies NewVerification
})

/** Models of a verification, as recorded with it: decision model for the statements, language model for the rest. */
export const verificationModel = (
  decision: { readonly modelId: string },
  model: { readonly modelId: string | undefined }
) => ({ modelId: `${decision.modelId} + ${model.modelId ?? "unknown"}` })
