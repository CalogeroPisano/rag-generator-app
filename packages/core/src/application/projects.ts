import { validateRepositoryUrl } from "../domain/source/repository-url.ts"
import { Effect, Redacted } from "effect"
import { AppConfig } from "./config.ts"
import { type CreateProjectInput, JobId, ProjectId, SnapshotId, type UserId } from "../domain/model.ts"
import { InvalidInputError } from "../domain/errors.ts"
import { ProjectRepository } from "../ports/outbound/repositories.ts"
import { SecretBox } from "../ports/outbound/secret-box.ts"
import { ensureUploadExists } from "./uploads.ts"

/** Creates a project with its first snapshot and queues the acquisition job. */
export const createProject = Effect.fn("createProject")(function* (input: CreateProjectInput, userId: UserId | null) {
  const config = yield* AppConfig
  const repository = yield* ProjectRepository
  const projectId = ProjectId.make(crypto.randomUUID())
  const source = input.source

  let encryptedToken: string | null = null
  if (source.type === "zip") {
    yield* ensureUploadExists(source.uploadId)
  } else {
    const url = validateRepositoryUrl(source.url, config.gitAllowHttp)
    if (!(url instanceof URL)) return yield* new InvalidInputError({ message: url.message })
    if (source.token !== undefined && source.token.length > 0) {
      const secretBox = yield* SecretBox
      encryptedToken = yield* secretBox.encrypt(Redacted.make(source.token), projectId)
    }
  }

  return yield* repository.createWithAcquisition({
    project: {
      id: projectId,
      name: input.name,
      sourceType: source.type,
      repositoryUrl: source.type === "git" ? source.url : null,
      repositoryRef: source.type === "git" && source.ref ? source.ref : null,
      repositoryUsername: source.type === "git" && source.username ? source.username : null,
      encryptedToken,
      createdBy: userId
    },
    snapshotId: SnapshotId.make(crypto.randomUUID()),
    uploadId: source.type === "zip" ? source.uploadId : null,
    jobId: JobId.make(crypto.randomUUID()),
    maxAttempts: config.jobMaxAttempts
  })
})
