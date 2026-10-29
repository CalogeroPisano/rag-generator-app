/** Shared fixtures of the understanding and review integration tests: a small project and scripted model answers. */
import { type CardContent } from "@code-to-rag/core"
import { type DecisionRequest, type OutputSchema, type StructuredRequest } from "@code-to-rag/core/outbound"
import { zipSync } from "fflate"

const encode = (text: string) => new TextEncoder().encode(text)

export const sampleProject = () =>
  zipSync({
    "web/src/orders/service.ts": encode(
      [
        `import { formatPrice } from "../lib/money"`,
        `/** Creates orders. */`,
        `export class OrderService {`,
        `  create(qty: number) {`,
        `    if (qty > 100) throw new Error("Massimo 100 pezzi")`,
        `    return formatPrice(qty)`,
        `  }`,
        `}`,
        ``
      ].join("\n")
    ),
    "web/src/lib/money.ts": encode(`export function formatPrice(value: number) { return value.toFixed(2) }\n`),
    "web/src/orders/service.test.ts": encode(`import { OrderService } from "./service"\n`),
    "config/app.json": encode(`{ "maxOrderQuantity": 100 }\n`),
    "README.md": encode("# Shop\n")
  })

export const card: CardContent = {
  title: "Orders",
  summary: "Users can create orders.",
  behavior: [
    {
      text: "Creates an order for the given quantity.",
      references: [{ path: "web/src/orders/service.ts", startLine: 4, endLine: 7 }]
    }
  ],
  configuration: [],
  parameters: [
    {
      name: "qty",
      description: "Quantity to order",
      type: "number",
      required: true,
      defaultValue: null,
      references: [{ path: "web/src/orders/service.ts", startLine: 4, endLine: 4 }]
    }
  ],
  limits: [
    // Invented file: dropped by the reference check.
    { text: "At most 100 pieces.", references: [{ path: "web/src/invented.ts", startLine: 1, endLine: 2 }] }
  ],
  validationRules: [],
  errors: [
    {
      condition: "Quantity above 100",
      message: "Massimo 100 pezzi",
      references: [{ path: "web/src/orders/service.ts", startLine: 5, endLine: 5 }]
    }
  ]
}

/** A plausible answer for every prompt of the pipeline. */
export const defaultRespond = (request: StructuredRequest<OutputSchema>): unknown => {
  switch (request.prompt.id) {
    case "file-summary": {
      const path = /^File: (\S+)/.exec(request.input)?.[1] ?? "?"
      const names = [...request.input.matchAll(/^- \w+ (\S+) \(lines/gm)].map((m) => m[1])
      return { summary: `Summary of ${path}.`, symbols: names.map((name) => ({ name, summary: `About ${name}.` })) }
    }
    case "module-summary":
      return { summary: `Module ${/^Module: (.+)$/m.exec(request.input)?.[1] ?? "?"}.` }
    case "feature-map":
      return {
        features: [
          {
            name: "Orders",
            description: "Create orders.",
            files: ["web/src/orders/service.ts", "web/src/lib/money.ts", "web/src/invented.ts"],
            symbols: ["OrderService.create", "formatPrice"]
          },
          { name: "Ghost", description: "Not in the code.", files: ["nowhere.ts"], symbols: [] }
        ]
      }
    case "card":
      return card
    default:
      return undefined
  }
}

/**
 * Decision model answers of the card verification: the invented limit is unsupported, the rest supported, and the
 * card probably misses the quantity rule.
 */
export const defaultDecide = (request: DecisionRequest): Record<string, number> =>
  request.prompt.id === "card-verify"
    ? { "behavior.0": 0.95, "parameters.0": 0.92, "limits.0": 0.05, "errors.0": 0.9, missing: 0.8 }
    : {}

/** A verification that finds nothing to report. */
export const cleanDecide = (request: DecisionRequest): Record<string, number> =>
  Object.fromEntries(Object.keys(request.questions).map((name) => [name, name === "missing" ? 0.1 : 0.95]))
