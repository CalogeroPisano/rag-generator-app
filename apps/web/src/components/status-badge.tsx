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
