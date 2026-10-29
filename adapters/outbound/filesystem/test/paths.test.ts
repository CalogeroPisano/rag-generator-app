import { describe, expect, it } from "vitest"
import { sanitizeArchivePath } from "../src/paths.ts"

describe("sanitizeArchivePath", () => {
  it.each([
    ["../etc/passwd"],
    ["a/../../b"],
    ["/etc/passwd"],
    ["C:\\Windows\\system32"],
    ["..\\..\\evil.txt"],
    ["a\0b"],
    ["./"]
  ])("rejects %j", (name) => {
    expect(sanitizeArchivePath(name)).toBeUndefined()
  })

  it("normalises separators and dot segments", () => {
    expect(sanitizeArchivePath("src\\app/./main.ts")).toBe("src/app/main.ts")
  })
})
