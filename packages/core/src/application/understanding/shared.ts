/** Helpers shared by the understanding pipeline and the card jobs. */
import { estimateTokens } from "../prompts/format.ts"
import { AiError, type LanguageModel, type PromptRef } from "../../ports/outbound/models.ts"
import { Effect } from "effect"
import { PhaseError } from "../../domain/errors.ts"

/** Tokens kept free for the chat template and estimation errors. */
const SAFETY_TOKENS = 512

export const chunks = <A>(items: ReadonlyArray<A>, size: number): Array<ReadonlyArray<A>> => {
  const result: Array<ReadonlyArray<A>> = []
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size))
  return result
}

export const groupBy = <A>(items: ReadonlyArray<A>, key: (item: A) => string): Map<string, Array<A>> => {
  const groups = new Map<string, Array<A>>()
  for (const item of items) {
    const k = key(item)
    const group = groups.get(k)
    if (group === undefined) groups.set(k, [item])
    else group.push(item)
  }
  return groups
}

/** Database errors are transient; model errors carry their own `retryable`. */
export const toPhaseError = (phase: string) => (error: { readonly _tag: string }) => {
  if (error instanceof AiError) return new PhaseError({ phase, message: error.message, retryable: error.retryable })
  if (error instanceof PhaseError) return error
  return new PhaseError({
    phase,
    message: error._tag === "DatabaseError" ? "Errore del database" : "Errore imprevisto durante la comprensione",
    retryable: error._tag !== "NotFoundError"
  })
}

/**
 * Runs a model task for one item; an answer still invalid after the correction
 * request skips the item (counted) instead of failing the whole job.
 */
export const skipInvalid = <A, E, R>(effect: Effect.Effect<A, E, R>, onSkip: () => void) =>
  effect.pipe(
    Effect.map((value): A | undefined => value),
    Effect.catchIf(
      (error): error is E & AiError => error instanceof AiError && error.kind === "invalid_output",
      () => Effect.sync(() => (onSkip(), undefined))
    )
  )

/** Input token budget of a prompt with the given instructions. */
export const inputBudget = (model: typeof LanguageModel.Service, instructions: string): number =>
  model.contextTokens - model.maxOutputTokens - estimateTokens(instructions) - SAFETY_TOKENS

export const provenance = (model: { readonly modelId: string | undefined }, prompt: PromptRef) => ({
  model: model.modelId ?? "unknown",
  promptVersion: prompt.version
})
