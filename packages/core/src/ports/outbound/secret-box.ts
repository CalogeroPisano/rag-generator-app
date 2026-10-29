import { Context, type Effect, type Redacted } from "effect"
import type { EncryptionError } from "../../domain/errors.ts"

/**
 * Authenticated encryption of secrets stored in the database, such as Git
 * access tokens. `context` is bound to the ciphertext, so a ciphertext copied
 * to another row (e.g. another project) fails to decrypt. Implemented with
 * AES-256-GCM by `@code-to-rag/postgres`.
 */
export class SecretBox extends Context.Service<
  SecretBox,
  {
    encrypt(plain: Redacted.Redacted, context: string): Effect.Effect<string, EncryptionError>
    decrypt(sealed: string, context: string): Effect.Effect<Redacted.Redacted, EncryptionError>
  }
>()("code-to-rag/core/SecretBox") {}
