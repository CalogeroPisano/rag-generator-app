import { CheckCircle2Icon, CircleIcon, RotateCcwIcon, XCircleIcon } from "lucide-react"
import { JobStatusBadge } from "@/components/status-badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner"
import type { JobStream } from "@/hooks/use-job-stream"
import { jobTypes, phaseLabels } from "@/lib/format"

const eventLabels: Record<string, string> = {
  queued: "In coda",
  started: "Avviato",
  phase_started: "Fase avviata",
  progress: "Avanzamento",
  phase_completed: "Fase completata",
  retry_scheduled: "Nuovo tentativo pianificato",
  succeeded: "Completato",
  failed: "Fallito",
  cancelled: "Annullato"
}

const time = new Intl.DateTimeFormat("it-IT", { timeStyle: "medium" })

export function JobProgress({
  stream,
  onRetry,
  retrying
}: {
  stream: JobStream
  onRetry: () => void
  retrying: boolean
}) {
  const { job, events } = stream
  if (job === undefined) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Spinner /> Connessione all'avanzamento…
          </CardTitle>
        </CardHeader>
      </Card>
    )
  }

  const phaseState = (phase: string) => {
    if (job.completedPhases.includes(phase)) return "done"
    if (job.currentPhase === phase)
      return job.status === "failed" ? "failed" : job.status === "running" ? "running" : "pending"
    return "pending"
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{job.update ? "Aggiornamento alla nuova versione" : jobTypes[job.type].title}</CardTitle>
        <CardDescription>
          Tentativo {Math.max(job.attempts, 1)} di {job.maxAttempts}
        </CardDescription>
        <CardAction>
          <JobStatusBadge status={job.status} />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ol className="grid gap-3 sm:grid-cols-3">
          {jobTypes[job.type].phases.map((phase) => {
            const state = phaseState(phase)
            return (
              <li key={phase} className="flex items-center gap-2 rounded-md border p-3 text-sm">
                {state === "done" && <CheckCircle2Icon className="size-4 text-success" />}
                {state === "running" && <Spinner className="text-info" />}
                {state === "failed" && <XCircleIcon className="size-4 text-destructive" />}
                {state === "pending" && <CircleIcon className="size-4 text-muted-foreground" />}
                <span className={state === "pending" ? "text-muted-foreground" : undefined}>{phaseLabels[phase]}</span>
              </li>
            )
          })}
        </ol>
        {job.progress !== null && job.progress.message !== null && job.status === "running" && (
          <p className="text-sm text-muted-foreground">{job.progress.message}</p>
        )}
        {job.lastError !== null && job.status !== "succeeded" && (
          <Alert variant={job.status === "failed" ? "destructive" : "default"}>
            <AlertTitle>
              {job.status === "failed" ? `${jobTypes[job.type].title}: operazione non riuscita` : "Errore temporaneo"}
            </AlertTitle>
            <AlertDescription>
              <p>{job.lastError}</p>
              {job.status === "failed" && (
                <Button size="sm" variant="outline" className="mt-2" onClick={onRetry} disabled={retrying}>
                  {retrying ? <Spinner data-icon="inline-start" /> : <RotateCcwIcon data-icon="inline-start" />}
                  Riprova dalla fase fallita
                </Button>
              )}
            </AlertDescription>
          </Alert>
        )}
        <Collapsible>
          <CollapsibleTrigger asChild>
            <Button variant="link" size="sm" className="h-auto px-0">
              Registro eventi ({events.length})
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ScrollArea className="h-48 rounded-md border">
              <ul className="divide-y text-xs">
                {events.map((event) => (
                  <li key={event.id} className="flex gap-3 px-3 py-1.5">
                    <span className="shrink-0 text-muted-foreground tabular-nums">
                      {time.format(new Date(event.createdAt))}
                    </span>
                    <span className="shrink-0 font-medium">{eventLabels[event.kind] ?? event.kind}</span>
                    {event.phase !== null && (
                      <span className="shrink-0 text-muted-foreground">{phaseLabels[event.phase] ?? event.phase}</span>
                    )}
                    <span className="min-w-0 truncate">{event.message ?? event.progress?.message ?? ""}</span>
                  </li>
                ))}
              </ul>
            </ScrollArea>
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  )
}
