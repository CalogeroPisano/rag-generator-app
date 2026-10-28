import { describe, expect, it } from "vitest"
import {
  applyFeatureUpdate,
  carryFeatures,
  changedPaths,
  diffFiles,
  dirtyModules,
  featureAffected,
  featureChangedFiles
} from "../src/understanding/update.ts"

const declaration = (path: string, qualifiedName: string) => ({
  path,
  kind: "function",
  qualifiedName,
  container: null,
  exported: true,
  startLine: 1,
  endLine: 2
})

describe("diffFiles", () => {
  it("compares paths and content hashes", () => {
    const changes = diffFiles(
      [
        { path: "a.ts", contentHash: "1" },
        { path: "b.ts", contentHash: "2" },
        { path: "c.ts", contentHash: "3" }
      ],
      [
        { path: "d.ts", contentHash: "4" },
        { path: "b.ts", contentHash: "2" },
        { path: "a.ts", contentHash: "9" }
      ]
    )
    expect(changes).toEqual({ added: ["d.ts"], modified: ["a.ts"], removed: ["c.ts"], unchanged: ["b.ts"] })
    expect([...changedPaths(changes)].sort()).toEqual(["a.ts", "c.ts", "d.ts"])
  })
})

describe("dirtyModules", () => {
  it("marks every directory above a changed path, the root included", () => {
    expect([...dirtyModules(["src/orders/service.ts", "src/orders/model.ts", "README.md"])].sort()).toEqual([
      "",
      "src",
      "src/orders"
    ])
    expect(dirtyModules([]).size).toBe(0)
  })
})

describe("carryFeatures", () => {
  it("drops deleted files and declarations, and features left without files", () => {
    const carried = carryFeatures(
      [
        {
          name: "Orders",
          description: "Create orders.",
          files: ["src/orders.ts", "src/gone.ts"],
          symbols: [
            { path: "src/orders.ts", qualifiedName: "create" },
            { path: "src/orders.ts", qualifiedName: "removedFunction" },
            { path: "src/gone.ts", qualifiedName: "old" }
          ]
        },
        { name: "Legacy", description: "Removed.", files: ["src/gone.ts"], symbols: [] }
      ],
      { files: new Set(["src/orders.ts"]), declarations: [declaration("src/orders.ts", "create")] }
    )
    expect(carried).toEqual([
      {
        name: "Orders",
        description: "Create orders.",
        files: ["src/orders.ts"],
        symbols: [{ path: "src/orders.ts", qualifiedName: "create" }]
      }
    ])
  })
})

describe("applyFeatureUpdate", () => {
  it("adds files to features with the same name and appends the new ones", () => {
    const features = applyFeatureUpdate(
      [{ name: "Orders", description: "Create orders.", files: ["a.ts"], symbols: [] }],
      [
        {
          name: "orders!",
          description: "Other text.",
          files: ["a.ts", "b.ts"],
          symbols: [{ path: "b.ts", qualifiedName: "x" }]
        },
        { name: "Refunds", description: "Refunds.", files: ["c.ts"], symbols: [] },
        { name: "refunds", description: "Duplicate.", files: ["d.ts"], symbols: [] }
      ]
    )
    expect(features).toEqual([
      {
        name: "Orders",
        description: "Create orders.",
        files: ["a.ts", "b.ts"],
        symbols: [{ path: "b.ts", qualifiedName: "x" }]
      },
      { name: "Refunds", description: "Refunds.", files: ["c.ts", "d.ts"], symbols: [] }
    ])
  })
})

describe("featureAffected", () => {
  const changed = new Set(["b.ts"])
  it("is false when the files and their content are the same", () => {
    expect(featureAffected({ files: ["a.ts", "c.ts"] }, { files: ["c.ts", "a.ts"] }, changed)).toBe(false)
  })
  it("is true when a file changed, appeared or disappeared", () => {
    expect(featureAffected({ files: ["a.ts", "b.ts"] }, { files: ["a.ts", "b.ts"] }, changed)).toBe(true)
    expect(featureAffected({ files: ["a.ts"] }, { files: ["a.ts", "c.ts"] }, changed)).toBe(true)
    expect(featureAffected({ files: ["a.ts", "c.ts"] }, { files: ["a.ts"] }, new Set())).toBe(true)
  })
  it("lists the changed files of a feature for the prompt", () => {
    expect(
      featureChangedFiles({ files: ["a.ts", "b.ts", "x.ts"] }, { files: ["a.ts", "b.ts", "y.ts"] }, changed)
    ).toEqual(["b.ts", "x.ts", "y.ts"])
  })
})
