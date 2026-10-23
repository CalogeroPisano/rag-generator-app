import type { ExclusionReason } from "@code-to-rag/analysis"

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB"]
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toLocaleString("it-IT", { maximumFractionDigits: 1 })} ${units[unit]}`
}

const dateTime = new Intl.DateTimeFormat("it-IT", { dateStyle: "medium", timeStyle: "short" })
export const formatDateTime = (value: Date | string): string => dateTime.format(new Date(value))

export const exclusionReasonLabels: Record<ExclusionReason, { readonly label: string; readonly description: string }> =
  {
    dependency: { label: "Dipendenza", description: "Cartella di dipendenze esterne (es. node_modules, vendor)." },
    build_output: { label: "Output di build", description: "File prodotti dalla compilazione (es. dist, build, bin)." },
    vcs: { label: "Controllo versione", description: "Metadati del sistema di controllo versione." },
    tooling: { label: "Strumenti", description: "Configurazioni di IDE o cache di strumenti." },
    lockfile: { label: "Lockfile", description: "File di blocco delle versioni delle dipendenze." },
    minified: { label: "Minificato", description: "Codice minificato, non leggibile." },
    source_map: { label: "Source map", description: "Mappa dei sorgenti generata dal bundler." },
    generated: { label: "Generato", description: "File generato automaticamente da uno strumento." },
    binary: { label: "Binario", description: "File binario (immagini, archivi, eseguibili, documenti)." },
    too_large: { label: "Troppo grande", description: "Supera la dimensione massima analizzabile per file." },
    symlink: { label: "Collegamento", description: "Collegamento simbolico: non viene seguito per sicurezza." },
    sensitive_file: {
      label: "File sensibile",
      description: "Contiene probabilmente credenziali (es. .env, chiavi private): escluso per sicurezza."
    },
    unreadable: {
      label: "Non leggibile",
      description: "Voce cifrata, compressa in modo non supportato o in conflitto."
    }
  }

export const phaseLabels: Record<string, string> = {
  fetch: "Acquisizione sorgente",
  ingest: "Filtro e mascheramento",
  parse: "Analisi sintattica",
  resolve: "Risoluzione dipendenze",
  finalize: "Completamento"
}

/** Phases of each job type, in execution order, and the title of its progress card. */
export const jobTypes: Record<
  "acquisition" | "analysis",
  { readonly title: string; readonly phases: ReadonlyArray<string> }
> = {
  acquisition: { title: "Acquisizione", phases: ["fetch", "ingest", "finalize"] },
  analysis: { title: "Analisi statica", phases: ["parse", "resolve", "finalize"] }
}
