import { describe, expect, it } from "vitest"
import { Duration } from "effect"
import { retryDelay } from "../src/pipeline.ts"

describe("retryDelay", () => {
  it("backs off exponentially and is capped", () => {
    expect(Duration.toSeconds(retryDelay(1))).toBe(30)
    expect(Duration.toSeconds(retryDelay(2))).toBe(60)
    expect(Duration.toSeconds(retryDelay(3))).toBe(120)
    expect(Duration.toSeconds(retryDelay(20))).toBe(900)
  })
})
