import { AppConfig, CodeAnalyzer, SecretBox } from "@code-to-rag/core"
import { DatabaseLive } from "@code-to-rag/db"
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

const WorkerLive = Layer.mergeAll(SecretBox.layer, CodeAnalyzer.layer, DatabaseLive).pipe(
  Layer.provideMerge(AppConfig.layer),
  Layer.provideMerge(LoggerLive)
)

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
