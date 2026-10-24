import type { getCard } from "@/functions/understanding.functions"

export type CardData = Awaited<ReturnType<typeof getCard>>
export type Content = CardData["content"]
export type Reference = Content["behavior"][number]["references"][number]
export type SectionName = "behavior" | "configuration" | "parameters" | "limits" | "validationRules" | "errors"

export const sectionLabels: Record<SectionName, string> = {
  behavior: "Cosa fa",
  configuration: "Configurazione",
  parameters: "Parametri",
  limits: "Limiti",
  validationRules: "Regole di validazione",
  errors: "Errori"
}

export const SECTIONS: ReadonlyArray<SectionName> = [
  "behavior",
  "configuration",
  "parameters",
  "limits",
  "validationRules",
  "errors"
]

/** A statement of a card with the id used by the verification (`section.index`). */
export interface Statement {
  readonly id: string
  readonly section: SectionName
  readonly index: number
  readonly references: ReadonlyArray<Reference>
}

export const statementsOf = (content: Content): Array<Statement> =>
  SECTIONS.flatMap((section) =>
    content[section].map((item, index) => ({
      id: `${section}.${index}`,
      section,
      index,
      references: item.references
    }))
  )

export const allReferences = (content: Content): Array<Reference> =>
  statementsOf(content).flatMap((statement) => statement.references)

export const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1)

export const formatReference = (reference: Reference) =>
  `${fileName(reference.path)}:${reference.startLine}${reference.endLine === reference.startLine ? "" : `–${reference.endLine}`}`
