/** Shared fixtures of the understanding and review integration tests: a small project and scripted model answers. */
import type { CardContent, OutputSchema, StructuredRequest } from "@code-to-rag/ai"
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
    case "card-verify":
      return {
        statements: [
          { id: "behavior.0", verdict: "supported", note: "" },
          { id: "parameters.0", verdict: "supported", note: "" },
          { id: "limits.0", verdict: "unsupported", note: "No such limit in the code." },
          { id: "errors.0", verdict: "supported", note: "" },
          { id: "unknown.9", verdict: "supported", note: "" }
        ],
        missing: [
          {
            section: "validationRules",
            text: "The quantity must not exceed 100.",
            references: [{ path: "web/src/orders/service.ts", startLine: 5, endLine: 5 }]
          }
        ]
      }
    default:
      return undefined
  }
}
