import { Effect } from "effect"
import { CodeAnalyzer } from "../ports/outbound/code-analyzer.ts"
import { AppConfig } from "./config.ts"
import { type Job, JobId, type SnapshotId } from "../domain/model.ts"
import { PhaseError } from "../domain/errors.ts"
import type { PhaseContext, Pipeline } from "./pipeline.ts"
import {
  AnalysisRepository,
  JobRepository,
  KnowledgeRepository,
  type ParsedFile,
  ProjectRepository,
  SnapshotRepository,
  UnderstandingRepository
} from "../ports/outbound/repositories.ts"
import { UploadStore } from "../ports/outbound/source.ts"
import { continueNewVersion } from "./updates.ts"

const PARSE_BATCH_SIZE = 100
const RESOLVE_BATCH_SIZE = 1000

/** Languages (as detected at ingestion) that have a tree-sitter grammar. */
export const ANALYZED_LANGUAGES = ["typescript", "javascript", "java", "csharp", "go", "python"] as const

const toPhaseError = (phase: string) => (error: { readonly _tag: string }) =>
  new PhaseError({
    phase,
    message: error._tag === "DatabaseError" ? "Errore del database" : "Errore imprevisto durante l'analisi",
    retryable: true
  })

/** parse: extracts symbols and raw imports from every analyzable file. */
const parseFiles = Effect.fn("analysis.parse")(
  function* (job: Job, progress: PhaseContext["progress"]) {
    const repository = yield* AnalysisRepository
    const analyzer = yield* CodeAnalyzer
    // Idempotent: whatever a previous attempt stored is discarded.
    yield* repository.setStatus(job.snapshotId, "running")
    yield* repository.clear(job.snapshotId)

    let afterFileId = 0
    let parsed = 0
    for (;;) {
      const files = yield* repository.filesToAnalyze(job.snapshotId, afterFileId, PARSE_BATCH_SIZE, ANALYZED_LANGUAGES)
      if (files.length === 0) break
      const results: Array<ParsedFile> = []
      for (const file of files) {
        const analysis = analyzer.analyze(file.path, file.content)
        if (analysis === undefined) continue
        results.push({
          fileId: file.fileId,
          packageName: analysis.packageName,
          parseErrors: analysis.parseErrors,
          symbols: analysis.symbols,
          imports: analysis.imports
        })
      }
      yield* repository.saveParsed(job.snapshotId, results)
      afterFileId = files.at(-1)!.fileId
      parsed += files.length
      yield* progress({ completed: parsed, total: null, message: `${parsed} file analizzati` })
      // Parsing is CPU-bound: let other fibers (heartbeat, other jobs) run between batches.
      yield* Effect.yieldNow
    }
  },
  (effect) => effect.pipe(Effect.mapError(toPhaseError("parse")))
)

/** resolve: turns raw imports into file, directory, namespace or external targets. */
const resolveDependencies = Effect.fn("analysis.resolve")(
  function* (job: Job, progress: PhaseContext["progress"]) {
    const repository = yield* AnalysisRepository
    const analyzer = yield* CodeAnalyzer
    const resolve = analyzer.resolver(
      yield* repository.resolverInput(job.snapshotId, (path) => analyzer.isResolverConfigFile(path))
    )

    let afterId = 0
    let resolved = 0
    for (;;) {
      const pending = yield* repository.pendingDependencies(job.snapshotId, afterId, RESOLVE_BATCH_SIZE)
      if (pending.length === 0) break
      const targets = pending.map((dependency) => ({
        id: dependency.id,
        target: resolve(dependency.fromPath, dependency.entry)
      }))
      yield* repository.saveTargets(job.snapshotId, targets)
      afterId = pending.at(-1)!.id
      resolved += pending.length
      yield* progress({ completed: resolved, total: null, message: `${resolved} dipendenze risolte` })
      yield* Effect.yieldNow
    }
  },
  (effect) => effect.pipe(Effect.mapError(toPhaseError("resolve")))
)

const completeAnalysis = Effect.fn("analysis.finalize")(
  function* (job: Job) {
    const repository = yield* AnalysisRepository
    yield* repository.complete(job.snapshotId, (yield* CodeAnalyzer).version)
    // A new version moves on to its update (or becomes current).
    yield* continueNewVersion(job.snapshotId)
  },
  (effect) => effect.pipe(Effect.mapError(toPhaseError("finalize")))
)

export const analysisPipeline: Pipeline<
  | AnalysisRepository
  | AppConfig
  | CodeAnalyzer
  | JobRepository
  | KnowledgeRepository
  | ProjectRepository
  | SnapshotRepository
  | UnderstandingRepository
  | UploadStore
> = {
  type: "analysis",
  phases: [
    { name: "parse", run: ({ job, progress }) => parseFiles(job, progress) },
    { name: "resolve", run: ({ job, progress }) => resolveDependencies(job, progress) },
    { name: "finalize", run: ({ job }) => completeAnalysis(job) }
  ],
  onFailed: (job) =>
    AnalysisRepository.use((repository) => repository.setStatus(job.snapshotId, "failed")).pipe(Effect.ignore)
}

/**
 * Queues the static analysis of a snapshot (or returns the one already
 * queued/running). Used at the end of acquisition and by the "re-analyze" action.
 */
export const requestAnalysis = Effect.fn("requestAnalysis")(function* (snapshotId: SnapshotId) {
  const config = yield* AppConfig
  const jobs = yield* JobRepository
  const snapshots = yield* SnapshotRepository
  const repository = yield* AnalysisRepository
  const { snapshot } = yield* snapshots.get(snapshotId)
  const job = yield* jobs.enqueue({
    id: JobId.make(crypto.randomUUID()),
    type: "analysis",
    projectId: snapshot.projectId,
    snapshotId,
    maxAttempts: config.jobMaxAttempts
  })
  if (job.status === "queued") yield* repository.setStatus(snapshotId, "pending")
  return job
})
