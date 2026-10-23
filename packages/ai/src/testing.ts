import { Effect, Layer, Schema } from "effect"
import { AiError } from "./errors.ts"
import { LanguageModel, type OutputSchema, type StructuredRequest } from "./language-model.ts"

/**
 * Language model for tests of the code that uses the AI layer: `respond` gets
 * each request and returns the (encoded) answer, which is decoded with the
 * request schema like a real answer. Returning an `AiError` fails the call.
 */
export const scriptedLanguageModel = (
  respond: (request: StructuredRequest<OutputSchema>) => unknown,
  options: { readonly contextTokens?: number; readonly maxOutputTokens?: number } = {}
) =>
  Layer.succeed(
    LanguageModel,
    LanguageModel.of({
      modelId: "scripted-test-model",
      contextTokens: options.contextTokens ?? 16_384,
      maxOutputTokens: options.maxOutputTokens ?? 4096,
      generateObject: <S extends OutputSchema>(request: StructuredRequest<S>) =>
        Effect.suspend(() => {
          const answer = respond(request)
          if (answer instanceof AiError) return Effect.fail(answer)
          return Schema.decodeUnknownEffect(Schema.toCodecJson(request.schema))(answer).pipe(
            Effect.mapError(
              () => new AiError({ kind: "invalid_output", message: "Invalid scripted answer", retryable: false })
            )
          )
        })
    })
  )
