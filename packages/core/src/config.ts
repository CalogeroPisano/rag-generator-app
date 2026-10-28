import type { AcquisitionLimits } from "@code-to-rag/analysis"
import { Config, Context, Duration, Effect, Layer, Option } from "effect"
import * as nodePath from "node:path"

export interface AppConfigShape {
  /** Root of the data shared by web and worker (uploads, temporary work areas). */
  readonly dataDir: string
  readonly uploadsDir: string
  readonly workDir: string
  readonly limits: AcquisitionLimits
  readonly gitAllowHttp: boolean
  readonly gitCloneTimeout: Duration.Duration
  readonly jobMaxAttempts: number
  /** Directory with the tree-sitter wasm files; undefined in development (read from node_modules). */
  readonly grammarsDir: string | undefined
  readonly rag: {
    /** Cards given to the chat model per question. */
    readonly topCards: number
    /** Candidate chunks per search (vector and full-text) before fusion. */
    readonly candidates: number
    /** Language of the generated test questions (a language name, e.g. "Italian"). */
    readonly questionsLanguage: string
    readonly questionsPerCard: number
  }
}

const megabytes = (name: string, fallback: number) =>
  Config.Int(name).pipe(
    Config.withDefault(fallback),
    Config.map((value) => value * 1024 * 1024)
  )

/** Application configuration read from environment variables. */
export class AppConfig extends Context.Service<AppConfig, AppConfigShape>()("code-to-rag/core/AppConfig") {
  static readonly layer = Layer.effect(
    AppConfig,
    Effect.gen(function* () {
      const dataDir = nodePath.resolve(yield* Config.String("DATA_DIR").pipe(Config.withDefault("./.data")))
      return AppConfig.of({
        dataDir,
        uploadsDir: nodePath.join(dataDir, "uploads"),
        workDir: nodePath.join(dataDir, "work"),
        limits: {
          maxArchiveBytes: yield* megabytes("ACQUISITION_MAX_ARCHIVE_MB", 200),
          maxTotalBytes: yield* megabytes("ACQUISITION_MAX_TOTAL_MB", 1024),
          maxFileBytes: yield* megabytes("ACQUISITION_MAX_FILE_MB", 1),
          maxFiles: yield* Config.Int("ACQUISITION_MAX_FILES").pipe(Config.withDefault(50_000))
        },
        gitAllowHttp: yield* Config.Boolean("GIT_ALLOW_HTTP").pipe(Config.withDefault(false)),
        gitCloneTimeout: yield* Config.Duration("GIT_CLONE_TIMEOUT").pipe(Config.withDefault(Duration.minutes(10))),
        jobMaxAttempts: yield* Config.Int("JOB_MAX_ATTEMPTS").pipe(Config.withDefault(3)),
        grammarsDir: Option.getOrUndefined(yield* Config.option(Config.String("GRAMMARS_DIR"))),
        rag: {
          topCards: yield* Config.Int("RAG_TOP_CARDS").pipe(Config.withDefault(5)),
          candidates: yield* Config.Int("RAG_CANDIDATES").pipe(Config.withDefault(40)),
          questionsLanguage: yield* Config.String("TEST_QUESTIONS_LANGUAGE").pipe(Config.withDefault("Italian")),
          questionsPerCard: yield* Config.Int("TEST_QUESTIONS_PER_CARD").pipe(Config.withDefault(3))
        }
      })
    })
  )
}
