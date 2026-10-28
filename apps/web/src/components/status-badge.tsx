import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"

type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled"
type SnapshotStatus = "pending" | "acquiring" | "ready" | "failed"

const jobStatus: Record<
  JobStatus,
  { label: string; variant: "info" | "success" | "destructive" | "secondary" | "warning" }
> = {
  queued: { label: "In coda", variant: "secondary" },
  running: { label: "In esecuzione", variant: "info" },
  succeeded: { label: "Completato", variant: "success" },
  failed: { label: "Fallito", variant: "destructive" },
  cancelled: { label: "Annullato", variant: "warning" }
}

const snapshotStatus: Record<
  SnapshotStatus,
  { label: string; variant: "info" | "success" | "destructive" | "secondary" }
> = {
  pending: { label: "In attesa", variant: "secondary" },
  acquiring: { label: "In acquisizione", variant: "info" },
  ready: { label: "Pronto", variant: "success" },
  failed: { label: "Fallito", variant: "destructive" }
}

export function JobStatusBadge({ status }: { status: JobStatus }) {
  const { label, variant } = jobStatus[status]
  return (
    <Badge variant={variant}>
      {status === "running" && <Spinner data-icon="inline-start" />}
      {label}
    </Badge>
  )
}

export function SnapshotStatusBadge({ status }: { status: SnapshotStatus }) {
  const { label, variant } = snapshotStatus[status]
  return (
    <Badge variant={variant}>
      {status === "acquiring" && <Spinner data-icon="inline-start" />}
      {label}
    </Badge>
  )
}

type AnalysisStatus = "pending" | "running" | "ready" | "failed"

const analysisStatus: Record<
  AnalysisStatus,
  { label: string; variant: "info" | "success" | "destructive" | "secondary" }
> = {
  pending: { label: "Analisi in coda", variant: "secondary" },
  running: { label: "Analisi in corso", variant: "info" },
  ready: { label: "Analizzato", variant: "success" },
  failed: { label: "Analisi fallita", variant: "destructive" }
}

export function AnalysisStatusBadge({ status }: { status: AnalysisStatus }) {
  const { label, variant } = analysisStatus[status]
  return (
    <Badge variant={variant}>
      {status === "running" && <Spinner data-icon="inline-start" />}
      {label}
    </Badge>
  )
}

type UnderstandingStatus = "pending" | "running" | "ready" | "failed"

const understandingStatus: Record<
  UnderstandingStatus,
  { label: string; variant: "info" | "success" | "destructive" | "secondary" }
> = {
  pending: { label: "Comprensione in coda", variant: "secondary" },
  running: { label: "Comprensione in corso", variant: "info" },
  ready: { label: "Schede generate", variant: "success" },
  failed: { label: "Comprensione fallita", variant: "destructive" }
}

export function UnderstandingStatusBadge({ status }: { status: UnderstandingStatus }) {
  const { label, variant } = understandingStatus[status]
  return (
    <Badge variant={variant}>
      {status === "running" && <Spinner data-icon="inline-start" />}
      {label}
    </Badge>
  )
}

type CardStatus = "generated" | "flagged" | "in_review" | "approved" | "excluded" | "needs_recheck"

const cardStatus: Record<
  CardStatus,
  { label: string; variant: "info" | "success" | "destructive" | "secondary" | "warning" }
> = {
  generated: { label: "Generata", variant: "info" },
  flagged: { label: "Da verificare", variant: "warning" },
  in_review: { label: "In revisione", variant: "info" },
  approved: { label: "Approvata", variant: "success" },
  excluded: { label: "Esclusa", variant: "secondary" },
  needs_recheck: { label: "Da riverificare", variant: "warning" }
}

export function CardStatusBadge({ status }: { status: CardStatus }) {
  const { label, variant } = cardStatus[status]
  return <Badge variant={variant}>{label}</Badge>
}

const cardChange = {
  updated: { label: "Aggiornata", hint: "Riscritta per il codice della nuova versione" },
  created: { label: "Nuova", hint: "Funzionalità comparsa nella nuova versione" }
} as const

/** How the last update produced the card; nothing for cards copied unchanged or written by a full generation. */
export function CardChangeBadge({ change }: { change: "kept" | "updated" | "created" | null }) {
  if (change === null || change === "kept") return null
  const { label, hint } = cardChange[change]
  return (
    <Badge variant="outline" title={hint}>
      {label}
    </Badge>
  )
}
