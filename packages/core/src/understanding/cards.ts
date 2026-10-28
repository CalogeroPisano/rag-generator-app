/**
 * Writing and verifying one card. Shared by the `generate-cards` and
 * `verify-cards` phases of the understanding and by the card jobs of the
 * review (regenerate, correct, verify).
 */
import {
  CARD,
  CARD_VERIFY,
  CardContent,
  cardInstructions,
  cardStatements,
  CardVerifyOutput,
  cardVerifyInstructions,
  estimateTokens,
  LanguageModel,
  renderCard,
  renderCardExcerpt,
  renderCardVerify
} from "@code-to-rag/ai"
import { Effect } from "effect"
import type { FeatureSymbol, SnapshotId } from "../domain.ts"
import type { Declaration, NewVerification } from "../ports.ts"
import { KnowledgeRepository, UnderstandingRepository } from "../ports.ts"
import { buildCardExcerpts } from "./excerpts.ts"
import { type CheckedCard, checkReferenceList, checkReferences } from "./references.ts"
import { inputBudget } from "./shared.ts"

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

/** Verifies a card against the code of its feature. */
export const verifyCard = Effect.fnUntraced(function* (
  context: CallContext,
  feature: CardFeature,
  sources: CardSources,
  card: { readonly content: CardContent; readonly version: number; readonly unreferencedStatements: number }
) {
  const model = yield* LanguageModel
  const statements = cardStatements(card.content)
  const header = estimateTokens(renderCardVerify({ feature, card: card.content, excerpts: [] }))
  const cited = [
    ...card.content.behavior,
    ...card.content.configuration,
    ...card.content.parameters,
    ...card.content.limits,
    ...card.content.validationRules,
    ...card.content.errors
  ].flatMap((item) => item.references)
  const { excerpts, shown } = yield* excerptsFor(
    context,
    feature,
    sources,
    inputBudget(model, cardVerifyInstructions) - header,
    cited
  )
  const answer = yield* model.generateObject({
    prompt: CARD_VERIFY,
    context,
    instructions: cardVerifyInstructions,
    input: renderCardVerify({ feature, card: card.content, excerpts: excerpts.map(renderCardExcerpt) }),
    schema: CardVerifyOutput
  })

  // One verdict per statement: unknown ids are ignored, statements left out count as not assessed.
  const verdicts = new Map(answer.statements.map((s) => [s.id.trim(), s]))
  const assessed = statements.map((statement) => {
    const verdict = verdicts.get(statement.id)
    return verdict === undefined
      ? { id: statement.id, verdict: "partial" as const, note: "Not assessed by the verifier." }
      : { id: statement.id, verdict: verdict.verdict, note: verdict.note.trim() }
  })
  const missing = answer.missing
    .filter((item) => item.text.trim() !== "")
    .map((item) => ({ ...item, text: item.text.trim(), references: checkReferenceList(item.references, shown) }))
  const issues = assessed.filter((s) => s.verdict !== "supported").length + missing.length + card.unreferencedStatements
  return { cardVersion: card.version, statements: assessed, missing, issues } satisfies NewVerification
})
