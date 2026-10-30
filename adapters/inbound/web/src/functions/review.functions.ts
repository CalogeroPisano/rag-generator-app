import { CardContent, Job, Jobs, Knowledge, ProjectId, Projects, SnapshotId } from "@code-to-rag/core"
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
    runEffect(Knowledge.requestCardOperation(data.snapshotId, data.cardId, data.operation).pipe(Effect.map(encodeJob)))
  )

/** First card of a feature the triage found only technical (worker job). */
export const startFeatureCard = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(validate(Schema.Struct({ snapshotId: SnapshotId, featureId: Schema.String.check(Schema.isUUID()) })))
  .handler(({ data }) =>
    runEffect(Knowledge.requestFeatureCard(data.snapshotId, data.featureId).pipe(Effect.map(encodeJob)))
  )

/** Assisted correction: the reviewer's text is stored (it survives regenerations) and the card is rewritten. */
export const submitCorrection = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    validate(Schema.Struct({ ...CardRef, text: Schema.String.check(Schema.isMinLength(3), Schema.isMaxLength(4000)) }))
  )
  .handler(({ data, context }) =>
    runEffect(
      Knowledge.correctCard(data.snapshotId, data.cardId, data.text, reviewer(context.user)).pipe(Effect.map(encodeJob))
    )
  )

export const saveCardEdit = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(validate(Schema.Struct({ ...CardRef, content: CardContent })))
  .handler(({ data, context }) =>
    runEffect(Knowledge.editCard(data.snapshotId, data.cardId, data.content, reviewer(context.user)))
  )

export const changeCardStatus = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(validate(Schema.Struct({ ...CardRef, status: Schema.Literals(["approved", "excluded", "in_review"]) })))
  .handler(({ data, context }) =>
    runEffect(Knowledge.setCardStatus(data.snapshotId, data.cardId, data.status, reviewer(context.user)))
  )

/** The reviewer's decision on one statement (`null` removes it). */
export const changeStatementReview = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    validate(
      Schema.Struct({
        ...CardRef,
        statementId: Schema.String.check(Schema.isMaxLength(64)),
        verdict: Schema.NullOr(Schema.Literals(["confirmed", "wrong"]))
      })
    )
  )
  .handler(({ data, context }) =>
    runEffect(
      Knowledge.reviewStatement(data.snapshotId, data.cardId, data.statementId, data.verdict, reviewer(context.user))
    )
  )

/** Card jobs queued or running for a project: the review page shows which cards are being processed. */
export const listCardJobs = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(validate(Schema.Struct({ projectId: ProjectId })))
  .handler(({ data }) =>
    runEffect(
      Jobs.listActiveJobs(data.projectId).pipe(
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
  .handler(({ data }) => runEffect(Projects.removeProject(data.projectId, data.confirmName)))
