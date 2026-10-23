import { Config, Context, Effect, Layer, Redacted } from "effect"
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { EncryptionError } from "./errors.ts"

const VERSION = "v1"

/**
 * Authenticated encryption (AES-256-GCM) for secrets stored in the database,
 * such as Git access tokens. The master key comes from `APP_ENCRYPTION_KEY`
 * (32 bytes, base64). `context` is bound as additional authenticated data, so
 * a ciphertext copied to another row (e.g. another project) fails to decrypt.
 */
export class SecretBox extends Context.Service<
  SecretBox,
  {
    encrypt(plain: Redacted.Redacted, context: string): Effect.Effect<string, EncryptionError>
    decrypt(sealed: string, context: string): Effect.Effect<Redacted.Redacted, EncryptionError>
  }
>()("code-to-rag/core/SecretBox") {
  static readonly make = (key: Redacted.Redacted) =>
    Effect.gen(function* () {
      const keyBytes = Buffer.from(Redacted.value(key), "base64")
      if (keyBytes.length !== 32) {
        return yield* new EncryptionError({ message: "APP_ENCRYPTION_KEY must be 32 bytes encoded in base64" })
      }

      const encrypt = (plain: Redacted.Redacted, context: string) =>
        Effect.try({
          try: () => {
            const iv = randomBytes(12)
            const cipher = createCipheriv("aes-256-gcm", keyBytes, iv)
            cipher.setAAD(Buffer.from(context, "utf8"))
            const ciphertext = Buffer.concat([cipher.update(Redacted.value(plain), "utf8"), cipher.final()])
            const tag = cipher.getAuthTag()
            return [VERSION, iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(":")
          },
          catch: () => new EncryptionError({ message: "Cifratura non riuscita" })
        })

      const decrypt = (sealed: string, context: string) =>
        Effect.try({
          try: () => {
            const [version, iv, tag, ciphertext] = sealed.split(":")
            if (version !== VERSION || iv === undefined || tag === undefined || ciphertext === undefined) {
              throw new Error("format")
            }
            const decipher = createDecipheriv("aes-256-gcm", keyBytes, Buffer.from(iv, "base64"))
            decipher.setAAD(Buffer.from(context, "utf8"))
            decipher.setAuthTag(Buffer.from(tag, "base64"))
            const plain = Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()])
            return Redacted.make(plain.toString("utf8"))
          },
          // Never include the underlying error: it could echo parts of the input.
          catch: () => new EncryptionError({ message: "Decifratura non riuscita (chiave errata o dati alterati)" })
        })

      return SecretBox.of({ encrypt, decrypt })
    })

  static readonly layer = Layer.effect(SecretBox, Effect.flatMap(Config.Redacted("APP_ENCRYPTION_KEY"), SecretBox.make))
}
