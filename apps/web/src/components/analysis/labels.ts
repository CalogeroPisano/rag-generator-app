import type { SymbolKind } from "@code-to-rag/analysis"
import type { getFileAnalysis, getDependencyOverview } from "@/functions/analysis.functions"

export type FileAnalysisData = Awaited<ReturnType<typeof getFileAnalysis>>
export type SymbolData = FileAnalysisData["symbols"][number]
export type DependencyData = FileAnalysisData["imports"][number]
export type OverviewData = Awaited<ReturnType<typeof getDependencyOverview>>
export type TargetKind = DependencyData["targetKind"]

export const symbolKindLabels: Record<SymbolKind, string> = {
  namespace: "Namespace",
  module: "Modulo",
  class: "Classe",
  interface: "Interfaccia",
  enum: "Enum",
  struct: "Struct",
  record: "Record",
  type: "Tipo",
  function: "Funzione",
  method: "Metodo",
  constructor: "Costruttore",
  property: "Proprietà",
  field: "Campo",
  constant: "Costante",
  variable: "Variabile"
}

export const symbolKinds = Object.keys(symbolKindLabels) as Array<SymbolKind>

export const targetKindLabels: Record<TargetKind, { readonly label: string; readonly description: string }> = {
  file: { label: "File", description: "File del progetto" },
  directory: { label: "Package", description: "Package o cartella del progetto (Go, import Java con *)" },
  namespace: { label: "Namespace", description: "Namespace dichiarato nel progetto (C#)" },
  external: { label: "Esterno", description: "Libreria o modulo esterno al progetto" },
  unresolved: { label: "Non risolto", description: "Riferimento interno che non corrisponde a nessun file" },
  pending: { label: "In attesa", description: "Non ancora risolto" }
}
