import { describe, expect, it } from "vitest"
import { maskSecrets } from "../src/domain/source/secrets.ts"

describe("maskSecrets", () => {
  it("masks well-known token formats", () => {
    const source = [
      `const aws = "AKIAIOSFODNN7EXAMPLE"`,
      `const gh = "ghp_${"a".repeat(36)}"`,
      // Built at runtime: a literal key would trip secret scanners (e.g. GitHub push protection).
      `const stripe = "${["sk", "live", "4eC39HqLyjWDarjtT1zdp7dc"].join("_")}"`,
      `const google = "AIza${"B".repeat(35)}"`
    ].join("\n")
    const result = maskSecrets(source)
    expect(result.text).not.toContain("AKIAIOSFODNN7EXAMPLE")
    expect(result.text).not.toContain("ghp_")
    expect(result.text).not.toContain("sk_live_")
    expect(result.text).not.toContain("AIza")
    expect(result.findings.map((f) => f.line)).toEqual([1, 2, 3, 4])
  })

  it("masks secrets assigned to sensitive keys, quoted or not", () => {
    const source = [
      `DB_PASSWORD=Sup3rS3cr3t!`,
      `const jwtSecret = "k9$Fq2!xLm#83vZ"`,
      `  "client_secret": "a8f5f167f44f4964e6c998dee827110c",`,
      `spring.datasource.password: hunter2hunter2`
    ].join("\n")
    const result = maskSecrets(source)
    expect(result.text).not.toContain("Sup3rS3cr3t!")
    expect(result.text).not.toContain("k9$Fq2!xLm#83vZ")
    expect(result.text).not.toContain("a8f5f167f44f4964e6c998dee827110c")
    expect(result.text).not.toContain("hunter2hunter2")
    expect(result.text).toContain(`const jwtSecret = "[REDACTED:assigned-secret]"`)
  })

  it("keeps validation messages, references and placeholders readable", () => {
    const source = [
      `if (!password) throw new Error("Password is required")`,
      `const passwordMessage = "La password deve avere almeno 8 caratteri"`,
      `password: process.env.DB_PASSWORD,`,
      `@Value("\${db.password}") private String password;`,
      `<input type="password" name="password" />`,
      `const tokenType = "Bearer"`
    ].join("\n")
    const result = maskSecrets(source)
    expect(result.text).toBe(source)
    expect(result.findings).toEqual([])
  })

  it("leaves expressions assigned to sensitive names in source code untouched", () => {
    const typescript = [
      `const schema = z.object({`,
      `  password: z.string().min(8),`,
      `  confirmPassword: z.string()`,
      `})`
    ].join("\n")
    const python = [
      `password = request.form["password"]`,
      `self._cv_token: contextvars.Token[AppContext] | None = None`,
      `secret_key = ConfigAttribute[str | bytes | None]("SECRET_KEY")`
    ].join("\n")
    const csharp = `PasswordHash = table.Column<string>(type: "nvarchar(max)", nullable: true),`
    expect(maskSecrets(typescript, "typescript").text).toBe(typescript)
    expect(maskSecrets(python, "python").text).toBe(python)
    expect(maskSecrets(csharp, "csharp").text).toBe(csharp)
    // Quoted literals are still masked in code.
    expect(maskSecrets(`const dbPassword = "k9$Fq2!xLm#83vZ"`, "typescript").text).not.toContain("k9$Fq2")
    // Unquoted values are still masked in configuration files.
    expect(maskSecrets(`DB_PASSWORD=Sup3rS3cr3t!`, "plaintext").text).not.toContain("Sup3rS3cr3t!")
    expect(maskSecrets(`spring.datasource.password=hunter2hunter2`, "ini").text).not.toContain("hunter2")
  })

  it("masks any literal assigned to a password key, even short or simple ones", () => {
    const source = [
      `this.state = { loginSuccess: false, username: 'calogero', password: 'test' };`,
      `const adminPwd = "admin1"`,
      `user.Passphrase = "abc";`
    ].join("\n")
    const result = maskSecrets(source, "javascript")
    expect(result.text.split("\n")[0]).toBe(
      `this.state = { loginSuccess: false, username: 'calogero', password: '[REDACTED:assigned-password]' };`
    )
    expect(result.text).not.toContain("admin1")
    expect(result.text).not.toContain(`"abc"`)
    expect(result.findings).toEqual([
      { rule: "assigned-password", line: 1 },
      { rule: "assigned-password", line: 2 },
      { rule: "assigned-password", line: 3 }
    ])
    // Unquoted in configuration files.
    expect(maskSecrets(`DB_PASSWORD=test`, "plaintext").text).toBe(`DB_PASSWORD=[REDACTED:assigned-password]`)
    // Messages, references, masks and empty values stay readable.
    const harmless = [
      `const password = ""`,
      `const passwordHint = "Almeno 8 caratteri"`,
      `password: "\${DB_PASSWORD}",`,
      `password: "****",`,
      `passwordType: "string",`
    ].join("\n")
    expect(maskSecrets(harmless, "typescript").text).toBe(harmless)
  })

  it("masks credentials inside connection strings but keeps the rest", () => {
    const result = maskSecrets(`url = "postgres://app:s3cr3tPass@db.internal:5432/app"`)
    expect(result.text).toBe(`url = "postgres://app:[REDACTED:url-credentials]@db.internal:5432/app"`)
  })

  it("preserves the number of lines when masking private keys", () => {
    const source = [
      "const key = `",
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEA1234567890abcdef",
      "abcdefghijklmnopqrstuvwxyz012345",
      "-----END RSA PRIVATE KEY-----",
      "`",
      "next()"
    ].join("\n")
    const result = maskSecrets(source)
    expect(result.text.split("\n")).toHaveLength(7)
    expect(result.text).not.toContain("MIIEowIBAAKCAQEA")
    expect(result.text.split("\n")[6]).toBe("next()")
    expect(result.findings).toEqual([{ rule: "private-key", line: 2 }])
  })

  it("never reports the secret value in findings", () => {
    const result = maskSecrets(`token = "glpat-abcdefghijklmnopqrstu"`)
    expect(JSON.stringify(result.findings)).not.toContain("glpat")
  })
})
