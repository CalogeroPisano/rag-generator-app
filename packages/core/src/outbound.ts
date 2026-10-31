/**
 * Entry point for the outbound adapters (postgres, openai, filesystem): the domain model and rules, and the
 * outbound ports they implement.
 */
export * from "./domain/model.ts"
export * from "./domain/errors.ts"
export * from "./domain/card.ts"
export * from "./domain/code.ts"
export * from "./domain/features.ts"
export * from "./domain/settings.ts"
export * from "./domain/source/exclusion.ts"
export * from "./domain/source/filters.ts"
export * from "./domain/source/languages.ts"
export * from "./domain/source/limits.ts"
export * from "./domain/source/paths.ts"
export * from "./domain/source/prepare.ts"
export * from "./domain/source/repository-url.ts"
export * from "./domain/source/secrets.ts"

export * from "./ports/outbound/archive.ts"
export * from "./ports/outbound/code-analyzer.ts"
export * from "./ports/outbound/job-events.ts"
export * from "./ports/outbound/models.ts"
export * from "./ports/outbound/repositories.ts"
export * from "./ports/outbound/secret-box.ts"
export * from "./ports/outbound/source.ts"
