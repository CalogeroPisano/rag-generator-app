/**
 * Triage of the feature map by the decision model, before any card is written:
 * features that the user documentation would not describe (bootstrap, build,
 * tests, developer tooling) get no card, which saves the language model's time.
 */
import type { DecisionQuestion, PromptRef } from "../../ports/outbound/models.ts"

export const FEATURE_TRIAGE: PromptRef = { id: "feature-triage", version: 1 }

/** Name of the only question of a triage request. */
export const USER_FACING_QUESTION = "user_facing"

export const userFacingQuestion: DecisionQuestion = {
  instructions: "Would the user documentation of this application describe this feature?",
  criteria: {
    true: "A capability that end users use, see or configure",
    false: "Technical setup, bootstrapping, build, testing or developer tooling"
  }
}

export const renderFeatureTriage = (feature: {
  readonly name: string
  readonly description: string
  readonly files: ReadonlyArray<string>
}): string =>
  [`Feature: ${feature.name}`, `Description: ${feature.description}`, `Files: ${feature.files.join(", ")}`].join("\n")
