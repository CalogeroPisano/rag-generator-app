import { Effect, Redacted } from "effect"
import { randomBytes } from "node:crypto"
import { describe, expect, it } from "vitest"
import { makeSecretBox } from "../src/secret-box.ts"

const makeBox = (key = randomBytes(32).toString("base64")) => Effect.runPromise(makeSecretBox(Redacted.make(key)))

describe("SecretBox", () => {
  it("round-trips a secret and never stores it in clear", async () => {
    const box = await makeBox()
    const sealed = await Effect.runPromise(box.encrypt(Redacted.make("glpat-super-secret"), "project-1"))
    expect(sealed).not.toContain("glpat")
    expect(sealed.startsWith("v1:")).toBe(true)
    const opened = await Effect.runPromise(box.decrypt(sealed, "project-1"))
    expect(Redacted.value(opened)).toBe("glpat-super-secret")
  })

  it("rejects a ciphertext moved to another context", async () => {
    const box = await makeBox()
    const sealed = await Effect.runPromise(box.encrypt(Redacted.make("token"), "project-1"))
    const error = await Effect.runPromise(Effect.flip(box.decrypt(sealed, "project-2")))
    expect(error._tag).toBe("EncryptionError")
  })

  it("rejects tampered data and wrong keys", async () => {
    const box = await makeBox()
    const other = await makeBox()
    const sealed = await Effect.runPromise(box.encrypt(Redacted.make("token"), "ctx"))
    const tampered = sealed.slice(0, -4) + (sealed.endsWith("AAAA") ? "BBBB" : "AAAA")
    expect((await Effect.runPromise(Effect.flip(box.decrypt(tampered, "ctx"))))._tag).toBe("EncryptionError")
    expect((await Effect.runPromise(Effect.flip(other.decrypt(sealed, "ctx"))))._tag).toBe("EncryptionError")
  })

  it("requires a 32-byte key", async () => {
    const error = await Effect.runPromise(Effect.flip(makeSecretBox(Redacted.make("c2hvcnQ="))))
    expect(error.message).toContain("32 bytes")
  })
})
