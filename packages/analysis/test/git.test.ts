import { describe, expect, it } from "vitest"
import { GitError } from "../src/errors.ts"
import { validateRepositoryUrl } from "../src/git.ts"

describe("validateRepositoryUrl", () => {
  it("accepts https URLs", () => {
    expect(validateRepositoryUrl("https://git.example.com/team/app.git", false)).toBeInstanceOf(URL)
  })

  it.each([
    ["http://git.example.com/app.git"],
    ["ssh://git@git.example.com/app.git"],
    ["file:///etc/passwd"],
    ["not a url"]
  ])("rejects %s", (url) => {
    expect(validateRepositoryUrl(url, false)).toBeInstanceOf(GitError)
  })

  it("accepts http only when allowed", () => {
    expect(validateRepositoryUrl("http://git.local/app.git", true)).toBeInstanceOf(URL)
  })

  it("rejects credentials embedded in the URL", () => {
    const result = validateRepositoryUrl("https://user:token@git.example.com/app.git", false)
    expect(result).toBeInstanceOf(GitError)
    expect((result as GitError).message).not.toContain("token@")
  })
})
