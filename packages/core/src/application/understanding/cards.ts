/**
 * Writing and verifying one card. Shared by the `generate-cards` and
 * `verify-cards` phases of the understanding and by the card jobs of the
 * review (regenerate, correct, verify).
 */
import { CARD, cardInstructions, renderCard, renderCardExcerpt } from "../prompts/card.ts"
import { estimateTokens } from "../prompts/format.ts"
import {
  CARD_VERIFY,
  cardStatements,
  MISSING_QUESTION,
  missingQuestion,
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
import { type CheckedCard, checkReferences } from "./references.ts"
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
 * Verifies a card against the code of its feature with the decision model: the probability that each statement is
 * supported (verdict by threshold) and that the card misses user-visible rules. No text is generated.
 *
 * The model reads the state once per question, so the time grows with state size × questions: a statement that
 * cites code is asked about its cited lines only (statements citing the same lines share a request); the question
 * on missing rules and statements without references get the card and the code of the whole feature.
 */
export const verifyCard = Effect.fnUntraced(function* (
  context: CallContext,
  feature: CardFeature,
  sources: CardSources,
  card: { readonly content: CardContent; readonly version: number; readonly unreferencedStatements: number }
) {
  const decision = yield* DecisionModel
  const understanding = yield* UnderstandingRepository
  const thresholds = (yield* AppConfig).verification
  const statements = cardStatements(card.content)
  const budget = (questions: ReadonlyArray<readonly [string, DecisionQuestion]>, header: string) =>
    decision.contextTokens - estimateTokens(header) - questionTokens(questions) - DECISION_SAFETY_TOKENS

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

  // The whole feature: the question on missing rules and the statements without references.
  const whole: Array<readonly [string, DecisionQuestion]> = [
    [MISSING_QUESTION, missingQuestion],
    ...(byCitation.get("") ?? []).map((s) => [s.id, statementQuestion(s.text)] as const)
  ]
  const wholeParts = chunks(whole, decision.maxQuestions)
  const header = renderCardVerify({ feature, card: card.content, excerpts: [] })
  const { excerpts } = yield* excerptsFor(
    context,
    feature,
    sources,
    Math.min(...wholeParts.map((part) => budget(part, header))),
    statements.flatMap((s) => s.cited)
  )
  const wholeState = renderCardVerify({ feature, card: card.content, excerpts: excerpts.map(renderCardExcerpt) })
  for (const part of wholeParts) groups.push({ state: wholeState, questions: part })

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

  const verdictOf = (probability: number): StatementVerdict =>
    probability >= thresholds.supported ? "supported" : probability < thresholds.unsupported ? "unsupported" : "partial"
  const assessed = statements.map((statement) => {
    const probability = answers.get(statement.id)
    return probability === undefined
      ? { id: statement.id, verdict: "partial" as const, note: "Not assessed by the verifier." }
      : { id: statement.id, verdict: verdictOf(probability), note: "", probability }
  })
  const missingProbability = answers.get(MISSING_QUESTION) ?? null
  const missingSuspected = missingProbability !== null && missingProbability >= thresholds.missing
  const issues =
    assessed.filter((s) => s.verdict !== "supported").length + (missingSuspected ? 1 : 0) + card.unreferencedStatements
  return {
    cardVersion: card.version,
    statements: assessed,
    missing: [],
    missingProbability,
    missingSuspected,
    issues
  } satisfies NewVerification
})
