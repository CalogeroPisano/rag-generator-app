import { AiConfig, EmbeddingModel, LanguageModel } from "@code-to-rag/ai"
import { AppConfig, SecretBox } from "@code-to-rag/core"
import { DatabaseLive, JobEventsListener } from "@code-to-rag/db"
import { Config, Effect, Layer, Logger, ManagedRuntime } from "effect"

const LoggerLive = Layer.unwrap(
  Effect.gen(function* () {
    const format = yield* Config.Literals(["json", "pretty"], "LOG_FORMAT").pipe(Config.withDefault("json" as const))
    return Logger.layer([format === "json" ? Logger.consoleJson : Logger.consolePretty()])
  })
)

// The web calls models for the RAG chat only (question embedding and streamed answer); every other model call
// runs in the worker. The model call log (ModelCallRecorder) is written by the database layer.
const AiLive = Layer.mergeAll(LanguageModel.layer, EmbeddingModel.layer).pipe(Layer.provideMerge(AiConfig.layer))

const AppLive = Layer.mergeAll(AppConfig.layer, AiLive, SecretBox.layer, JobEventsListener.layer).pipe(
  Layer.provideMerge(DatabaseLive),
  Layer.provideMerge(LoggerLive)
)

export type AppServices = Layer.Success<typeof AppLive>

const makeRuntime = () => ManagedRuntime.make(AppLive)

// One runtime per process. In development Vite re-evaluates modules on change:
// keep the runtime on globalThis so the pool and the LISTEN connection are not
// opened again on every reload.
const globalRuntime = globalThis as typeof globalThis & {
  __codeToRagRuntime?: ReturnType<typeof makeRuntime>
}

export const runtime = (globalRuntime.__codeToRagRuntime ??= makeRuntime())

const shutdown = () => {
  void runtime.dispose()
}
process.once("SIGTERM", shutdown)
process.once("SIGINT", shutdown)
