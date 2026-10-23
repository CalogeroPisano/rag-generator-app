import { AiConfig } from "@code-to-rag/ai"
import {
  CardView,
  FeatureMap,
  FileSummaryView,
  Job,
  KnowledgeRepository,
  ModelCallStats,
  requestUnderstanding,
  SnapshotId,
  UnderstandingRepository
} from "@code-to-rag/core"
import { createServerFn } from "@tanstack/react-start"
import { Effect, Option, Schema } from "effect"
import { authMiddleware } from "@/server/middleware"
import { runEffect } from "@/server/run.server"

const encodeFeatureMap = Schema.encodeSync(FeatureMap)
const encodeCard = Schema.encodeSync(CardView)
const encodeFileSummary = Schema.encodeSync(FileSummaryView)
const encodeStats = Schema.encodeSync(ModelCallStats)
const encodeJob = Schema.encodeSync(Job)

const validate = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
  Schema.toStandardSchemaV1(schema)

/** Whether the worker can call a model, and which one (no URL or key: they are server details). */
export const getAiStatus = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(() =>
    runEffect(
      AiConfig.use((config) => Effect.succeed({ configured: config.model !== undefined, model: config.model ?? null }))
    )
  )

export const startUnderstanding = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(validate(Schema.Struct({ snapshotId: SnapshotId })))
  .handler(({ data }) => runEffect(requestUnderstanding(data.snapshotId).pipe(Effect.map(encodeJob))))

export const getFeatureMap = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(validate(Schema.Struct({ snapshotId: SnapshotId })))
  .handler(({ data }) =>
    runEffect(
      KnowledgeRepository.use((knowledge) => knowledge.featureMap(data.snapshotId)).pipe(Effect.map(encodeFeatureMap))
    )
  )

export const getCard = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(validate(Schema.Struct({ snapshotId: SnapshotId, cardId: Schema.String.check(Schema.isUUID()) })))
  .handler(({ data }) =>
    runEffect(
      KnowledgeRepository.use((knowledge) => knowledge.getCard(data.snapshotId, data.cardId)).pipe(
        Effect.map(encodeCard)
      )
    )
  )

export const getFileSummary = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(validate(Schema.Struct({ snapshotId: SnapshotId, path: Schema.String.check(Schema.isMaxLength(4096)) })))
  .handler(({ data }) =>
    runEffect(
      KnowledgeRepository.use((knowledge) => knowledge.fileSummary(data.snapshotId, data.path)).pipe(
        Effect.map((summary) => (Option.isSome(summary) ? encodeFileSummary(summary.value) : null))
      )
    )
  )

export const getModelCallStats = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(validate(Schema.Struct({ snapshotId: SnapshotId })))
  .handler(({ data }) =>
    runEffect(
      UnderstandingRepository.use((repository) => repository.modelCallStats(data.snapshotId)).pipe(
        Effect.map(encodeStats)
      )
    )
  )
