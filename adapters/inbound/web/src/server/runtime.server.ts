import { DecisionModelFactoryLive } from "@code-to-rag/ollama"
import { EmbeddingModelFactoryLive, LanguageModelFactoryLive } from "@code-to-rag/openai"
import { FileAdaptersLive, ZipArchiveLive } from "@code-to-rag/filesystem"
import { AppConfig, ModelRegistry } from "@code-to-rag/core"
import { DatabaseLive, JobEventsListenerLive, SecretBoxLive } from "@code-to-rag/postgres"
import { Config, Effect, Layer, Logger, ManagedRuntime } from "effect"

const LoggerLive = Layer.unwrap(
  Effect.gen(function* () {
    const format = yield* Config.Literals(["json", "pretty"], "LOG_FORMAT").pipe(Config.withDefault("json" as const))
    return Logger.layer([format === "json" ? Logger.consoleJson : Logger.consolePretty()])
  })
)

// The web calls models for the RAG chat only (question embedding and streamed answer); every other model call
// runs in the worker. Models come from the settings page (or the environment until it is saved).
const ModelsLive = ModelRegistry.layer.pipe(
  Layer.provide(Layer.mergeAll(LanguageModelFactoryLive, EmbeddingModelFactoryLive, DecisionModelFactoryLive))
)

// The use cases of core run on the adapters (see adapters/inbound/worker/src/main.ts); the web needs no code analyzer.
const AppLive = Layer.mergeAll(ModelsLive, FileAdaptersLive, ZipArchiveLive, JobEventsListenerLive).pipe(
  Layer.provideMerge(SecretBoxLive),
  Layer.provideMerge(DatabaseLive),
  Layer.provideMerge(AppConfig.layer),
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
