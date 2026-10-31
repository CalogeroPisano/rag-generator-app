import { describe, expect, it } from "vitest"
import { missingKey, withMissingItem } from "../src/application/missing-items.ts"
import type { CardContent } from "../src/domain/card.ts"

const references = [{ path: "a.ts", startLine: 3, endLine: 4 }]
const empty: CardContent = {
  title: "T",
  summary: "S",
  behavior: [{ text: "Creates orders.", references }],
  configuration: [],
  parameters: [],
  limits: [],
  validationRules: [],
  errors: []
}

describe("withMissingItem", () => {
  it("appends statements to their section", () => {
    const card = withMissingItem(empty, { section: "behavior", text: "Sends a mail.", references })
    expect(card.behavior.map((s) => s.text)).toEqual(["Creates orders.", "Sends a mail."])
    expect(card.behavior[1]!.references).toEqual(references)
  })

  it("splits errors and parameters back from the rendered text", () => {
    const error = withMissingItem(empty, {
      section: "errors",
      text: 'Login fails (message: "Invalid credentials")',
      references
    })
    expect(error.errors).toEqual([{ condition: "Login fails", message: "Invalid credentials", references }])
    expect(withMissingItem(empty, { section: "errors", text: "Server unreachable", references }).errors[0]).toEqual({
      condition: "Server unreachable",
      message: null,
      references
    })
    expect(
      withMissingItem(empty, { section: "parameters", text: "username: name of the account", references }).parameters
    ).toEqual([
      {
        name: "username",
        description: "name of the account",
        type: null,
        required: null,
        defaultValue: null,
        references
      }
    ])
  })
})

describe("missingKey", () => {
  it("ignores case and spaces, not the section", () => {
    expect(missingKey({ section: "limits", text: "Max  10 items." })).toBe(
      missingKey({ section: "limits", text: "max 10 items. " })
    )
    expect(missingKey({ section: "limits", text: "Max 10 items." })).not.toBe(
      missingKey({ section: "errors", text: "Max 10 items." })
    )
  })
})
