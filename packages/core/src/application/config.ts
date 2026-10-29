import { Config, Context, Duration, Effect, Layer } from "effect"
import type { AcquisitionLimits } from "../domain/source/limits.ts"

export interface AppConfigShape {
  readonly limits: AcquisitionLimits
  readonly gitAllowHttp: boolean
  readonly gitCloneTimeout: Duration.Duration
  readonly jobMaxAttempts: number
  /** Versions kept per project, the current one included (older ones are deleted when a new one becomes current). */
  readonly snapshotRetention: number
  /** Thresholds on the decision model's probabilities in the card verification. */
  readonly verification: {
    /** A statement at or above this probability is supported. */
    readonly supported: number
    /** A statement below this probability is unsupported (in between: partial). */
    readonly unsupported: number
    /** At or above this probability the card is missing rules of the code (one more issue). */
    readonly missing: number
  }
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

const probability = (name: string, fallback: number) =>
  Config.Number(name).pipe(
    Config.withDefault(fallback),
    Config.map((value) => Math.min(1, Math.max(0, value)))
  )

/** Application configuration read from environment variables (adapters read their own). */
export class AppConfig extends Context.Service<AppConfig, AppConfigShape>()("code-to-rag/core/AppConfig") {
  static readonly layer = Layer.effect(
    AppConfig,
    Effect.gen(function* () {
      return AppConfig.of({
        limits: {
          maxArchiveBytes: yield* megabytes("ACQUISITION_MAX_ARCHIVE_MB", 200),
          maxTotalBytes: yield* megabytes("ACQUISITION_MAX_TOTAL_MB", 1024),
          maxFileBytes: yield* megabytes("ACQUISITION_MAX_FILE_MB", 1),
          maxFiles: yield* Config.Int("ACQUISITION_MAX_FILES").pipe(Config.withDefault(50_000))
        },
        gitAllowHttp: yield* Config.Boolean("GIT_ALLOW_HTTP").pipe(Config.withDefault(false)),
        gitCloneTimeout: yield* Config.Duration("GIT_CLONE_TIMEOUT").pipe(Config.withDefault(Duration.minutes(10))),
        jobMaxAttempts: yield* Config.Int("JOB_MAX_ATTEMPTS").pipe(Config.withDefault(3)),
        snapshotRetention: Math.max(1, yield* Config.Int("SNAPSHOT_RETENTION").pipe(Config.withDefault(3))),
        verification: {
          supported: yield* probability("VERIFY_SUPPORTED_THRESHOLD", 0.7),
          unsupported: yield* probability("VERIFY_UNSUPPORTED_THRESHOLD", 0.3),
          missing: yield* probability("VERIFY_MISSING_THRESHOLD", 0.5)
        },
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
