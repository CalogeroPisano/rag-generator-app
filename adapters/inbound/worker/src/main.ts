import { AiConfig, EmbeddingModelLive, LanguageModelLive } from "@code-to-rag/openai"
import { CodeAnalyzerLive, FileAdaptersLive, ZipArchiveLive } from "@code-to-rag/filesystem"
import { DecisionConfig, DecisionModelLive } from "@code-to-rag/ollama"
import { AppConfig } from "@code-to-rag/core"
import { DatabaseLive, SecretBoxLive } from "@code-to-rag/postgres"
import { Config, Effect, Exit, Fiber, Layer, Logger } from "effect"
import { randomUUID } from "node:crypto"
import { hostname } from "node:os"
import { runWorker, WorkerOptionsConfig } from "./worker.ts"

const LoggerLive = Layer.unwrap(
  Effect.gen(function* () {
    const format = yield* Config.Literals(["json", "pretty"], "LOG_FORMAT").pipe(Config.withDefault("json" as const))
    return Logger.layer([format === "json" ? Logger.consoleJson : Logger.consolePretty()])
  })
)

// The model call log (ModelCallRecorder) is written by the database layer.
const AiLive = Layer.mergeAll(
  Layer.mergeAll(LanguageModelLive, EmbeddingModelLive).pipe(Layer.provide(AiConfig.layer)),
  DecisionModelLive.pipe(Layer.provide(DecisionConfig.layer))
)

// The use cases of core run on the adapters: Postgres (repositories, secret encryption), the model endpoint,
// the decision model (Ollama), the local file system (uploads, work areas) and tree-sitter.
const WorkerLive = Layer.mergeAll(
  SecretBoxLive,
  CodeAnalyzerLive,
  FileAdaptersLive,
  ZipArchiveLive,
  AiLive.pipe(Layer.provideMerge(DatabaseLive))
).pipe(Layer.provideMerge(AppConfig.layer), Layer.provideMerge(LoggerLive))

const workerId = `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`

const program = Effect.flatMap(WorkerOptionsConfig(workerId), runWorker).pipe(Effect.provide(WorkerLive))

const fiber = Effect.runFork(program)

// On SIGTERM/SIGINT, interrupting the fiber hands running jobs back to the queue.
const shutdown = () => {
  Effect.runFork(Fiber.interrupt(fiber))
}
process.once("SIGTERM", shutdown)
process.once("SIGINT", shutdown)

fiber.addObserver((exit) => {
  process.exitCode = Exit.isSuccess(exit) || Exit.hasInterrupts(exit) ? 0 : 1
})
