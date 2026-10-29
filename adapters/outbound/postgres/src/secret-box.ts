import { EncryptionError, SecretBox } from "@code-to-rag/core/outbound"
import { Config, Effect, Layer, Redacted } from "effect"
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

const VERSION = "v1"

/**
 * Adapter of the `SecretBox` port: AES-256-GCM with the master key from `APP_ENCRYPTION_KEY` (32 bytes, base64);
 * the context is the additional authenticated data. Format: `v1:<iv>:<tag>:<ciphertext>` (base64 parts).
 */
export const makeSecretBox = (key: Redacted.Redacted) =>
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

export const SecretBoxLive = Layer.effect(
  SecretBox,
  Effect.flatMap(Config.Redacted("APP_ENCRYPTION_KEY"), makeSecretBox)
)
