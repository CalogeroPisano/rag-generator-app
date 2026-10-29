import { exportPreview, prepareExport, ProjectId } from "@code-to-rag/core"
import { createServerFn } from "@tanstack/react-start"
import { Effect, Schema } from "effect"
import { authMiddleware } from "@/server/middleware"
import { runEffect } from "@/server/run.server"

/** What the export of the current version would contain (the file itself is streamed by `/api/projects/$projectId/export`). */
export const getExportPreview = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(Schema.toStandardSchemaV1(Schema.Struct({ projectId: ProjectId, approvedOnly: Schema.Boolean })))
  .handler(({ data }) =>
    runEffect(prepareExport(data.projectId, data.approvedOnly).pipe(Effect.flatMap(exportPreview)))
  )
