import { CardContent } from "@code-to-rag/ai"
import {
  correctCard,
  deleteProject,
  editCard,
  InvalidInputError,
  Job,
  JobRepository,
  ProjectId,
  ProjectRepository,
  requestCardOperation,
  setCardStatus,
  SnapshotId
} from "@code-to-rag/core"
import { createServerFn } from "@tanstack/react-start"
import { Effect, Schema } from "effect"
import { authMiddleware } from "@/server/middleware"
import { runEffect } from "@/server/run.server"

const encodeJob = Schema.encodeSync(Job)

const validate = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
  Schema.toStandardSchemaV1(schema)

const CardRef = { snapshotId: SnapshotId, cardId: Schema.String.check(Schema.isUUID()) }

const reviewer = (user: { readonly id: string; readonly name: string }) => ({ id: user.id, name: user.name })

/** Model operations on a card run as worker jobs: verification and regeneration. */
export const startCardOperation = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(validate(Schema.Struct({ ...CardRef, operation: Schema.Literals(["verify", "regenerate"]) })))
  .handler(({ data }) =>
    runEffect(requestCardOperation(data.snapshotId, data.cardId, data.operation).pipe(Effect.map(encodeJob)))
  )

/** Assisted correction: the reviewer's text is stored (it survives regenerations) and the card is rewritten. */
export const submitCorrection = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    validate(Schema.Struct({ ...CardRef, text: Schema.String.check(Schema.isMinLength(3), Schema.isMaxLength(4000)) }))
  )
  .handler(({ data, context }) =>
    runEffect(correctCard(data.snapshotId, data.cardId, data.text, reviewer(context.user)).pipe(Effect.map(encodeJob)))
  )

export const saveCardEdit = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(validate(Schema.Struct({ ...CardRef, content: CardContent })))
  .handler(({ data, context }) =>
    runEffect(editCard(data.snapshotId, data.cardId, data.content, reviewer(context.user)))
  )

export const changeCardStatus = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(validate(Schema.Struct({ ...CardRef, status: Schema.Literals(["approved", "excluded", "in_review"]) })))
  .handler(({ data, context }) =>
    runEffect(setCardStatus(data.snapshotId, data.cardId, data.status, reviewer(context.user)))
  )

/** Card jobs queued or running for a project: the review page shows which cards are being processed. */
export const listCardJobs = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(validate(Schema.Struct({ projectId: ProjectId })))
  .handler(({ data }) =>
    runEffect(
      JobRepository.use((jobs) => jobs.active(data.projectId)).pipe(
        Effect.map((jobs) =>
          jobs.flatMap((job) => {
            const payload = job.payload
            return job.type !== "card" || payload === null || !("operation" in payload)
              ? []
              : [{ jobId: job.id, status: job.status, featureId: payload.featureId, operation: payload.operation }]
          })
        )
      )
    )
  )

/** Deletes a project; the name must be typed again as confirmation. */
export const removeProject = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(validate(Schema.Struct({ projectId: ProjectId, confirmName: Schema.String })))
  .handler(({ data }) =>
    runEffect(
      Effect.gen(function* () {
        const summary = yield* ProjectRepository.use((projects) => projects.get(data.projectId))
        if (summary.project.name !== data.confirmName.trim()) {
          return yield* new InvalidInputError({ message: "Il nome inserito non corrisponde a quello del progetto" })
        }
        yield* deleteProject(data.projectId)
      })
    )
  )
