/**
 * Entry point for the inbound adapters (web, worker): the domain model and the inbound ports, one namespace per
 * area (`Projects.createProject`, `Jobs.claimJob`…). Outbound adapters use `@code-to-rag/core/outbound`.
 */
export * from "./domain/model.ts"
export * from "./domain/errors.ts"
export * from "./domain/card.ts"
export * from "./domain/code.ts"
export * from "./domain/features.ts"
export * from "./domain/settings.ts"
export * from "./domain/source/exclusion.ts"
export * from "./domain/source/limits.ts"

export { AppConfig, type AppConfigShape } from "./application/config.ts"
export { ModelRegistry } from "./application/models.ts"

export * as Analysis from "./ports/inbound/analysis.ts"
export * as Evaluation from "./ports/inbound/evaluation.ts"
export * as Export from "./ports/inbound/export.ts"
export * as Jobs from "./ports/inbound/jobs.ts"
export * as Knowledge from "./ports/inbound/knowledge.ts"
export * as Projects from "./ports/inbound/projects.ts"
export * as Rag from "./ports/inbound/rag.ts"
export * as Settings from "./ports/inbound/settings.ts"
