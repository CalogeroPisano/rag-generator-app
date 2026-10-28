import { useQuery } from "@tanstack/react-query"
import { ChevronRightIcon } from "lucide-react"
import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { getTestRun, listTestRuns } from "@/functions/rag.functions"
import { formatDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"

type Verdict = "correct" | "partial" | "incorrect" | "no_answer"

const verdicts: Record<Verdict, { label: string; variant: "success" | "warning" | "destructive" | "secondary" }> = {
  correct: { label: "Corretta", variant: "success" },
  partial: { label: "Parziale", variant: "warning" },
  incorrect: { label: "Errata", variant: "destructive" },
  no_answer: { label: "Nessuna risposta", variant: "secondary" }
}

const percent = (value: number, total: number) =>
  total === 0 ? "–" : `${Math.round((value / total) * 100).toLocaleString("it-IT")}%`

function RunStatus({ status }: { status: "running" | "ready" | "failed" }) {
  if (status === "running")
    return (
      <Badge variant="info">
        <Spinner data-icon="inline-start" />
        In corso
      </Badge>
    )
  return status === "ready" ? <Badge variant="success">Completata</Badge> : <Badge variant="destructive">Fallita</Badge>
}

type Result = Awaited<ReturnType<typeof getTestRun>>["results"][number]

/** One question of a run; opening it shows the answer, the judge's note and the retrieved cards. */
function ResultRow({ result }: { result: Result }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <TableRow>
        <TableCell className="max-w-md">
          <button type="button" onClick={() => setOpen(!open)} className="flex items-start gap-1 text-left">
            <ChevronRightIcon className={cn("mt-0.5 size-4 shrink-0 transition-transform", open && "rotate-90")} />
            <span className="whitespace-normal">{result.question}</span>
          </button>
        </TableCell>
        <TableCell className="whitespace-normal">{result.expectedFeatureName}</TableCell>
        <TableCell className="text-right tabular-nums">
          {result.rank === null ? <Badge variant="destructive">Non trovata</Badge> : `${result.rank}ª`}
        </TableCell>
        <TableCell>
          {result.verdict === null ? (
            <Badge variant="outline">Non valutata</Badge>
          ) : (
            <Badge variant={verdicts[result.verdict].variant}>{verdicts[result.verdict].label}</Badge>
          )}
        </TableCell>
      </TableRow>
      {open && (
        <TableRow className="bg-muted/40 hover:bg-muted/40">
          <TableCell colSpan={4} className="whitespace-normal">
            <div className="flex flex-col gap-2 py-1 text-sm">
              <p className="whitespace-pre-wrap">{result.answer}</p>
              {result.note !== null && <p className="text-xs text-muted-foreground">Valutazione: {result.note}</p>}
              <p className="text-xs text-muted-foreground">
                Schede recuperate: {result.retrieved.map((r) => r.featureName).join(", ") || "nessuna"}
              </p>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  )
}

function RunDetail({ runId }: { runId: string }) {
  const run = useQuery({ queryKey: ["test-run", runId], queryFn: () => getTestRun({ data: { runId } }) })
  if (run.data === undefined) return <Skeleton className="h-48 w-full" />
  const { results } = run.data
  if (results.length === 0) return <p className="text-sm text-muted-foreground">Nessun risultato.</p>
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Domanda</TableHead>
          <TableHead>Scheda attesa</TableHead>
          <TableHead className="text-right">Posizione</TableHead>
          <TableHead>Esito</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {results.map((result) => (
          <ResultRow key={result.questionId} result={result} />
        ))}
      </TableBody>
    </Table>
  )
}

/** Test runs of the snapshot (most recent first) and the results of the selected one. */
export function TestRuns({ snapshotId, polling }: { snapshotId: string; polling: boolean }) {
  const runs = useQuery({
    queryKey: ["test-runs", snapshotId],
    queryFn: () => listTestRuns({ data: { snapshotId } }),
    refetchInterval: polling ? 3000 : false
  })
  const [selected, setSelected] = useState<string | undefined>()

  if (runs.data === undefined) return <Skeleton className="h-48 w-full" />
  if (runs.data.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle>Nessuna esecuzione</EmptyTitle>
          <EmptyDescription>
            «Esegui i test» pone ogni domanda alla chat: misura se la scheda attesa viene trovata e fa valutare la
            risposta al modello.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  const current = runs.data.find((run) => run.id === selected) ?? runs.data[0]!
  return (
    <div className="flex flex-col gap-4">
      <Card className="py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Esecuzione</TableHead>
              <TableHead>Stato</TableHead>
              <TableHead className="text-right">Domande</TableHead>
              <TableHead className="text-right">Scheda trovata</TableHead>
              <TableHead className="text-right">Al primo posto</TableHead>
              <TableHead className="text-right">MRR</TableHead>
              <TableHead>Risposte</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.data.map((run) => (
              <TableRow
                key={run.id}
                onClick={() => setSelected(run.id)}
                className={cn("cursor-pointer", run.id === current.id && "bg-muted")}
              >
                <TableCell>
                  <div className="flex flex-col">
                    <span>{formatDateTime(run.startedAt)}</span>
                    <span className="text-xs text-muted-foreground">
                      {run.model} · {run.embeddingModel} · prime {run.topK} schede
                      {run.approvedOnly ? " · solo approvate" : ""}
                    </span>
                  </div>
                </TableCell>
                <TableCell>
                  <RunStatus status={run.status} />
                </TableCell>
                <TableCell className="text-right tabular-nums">{run.questions}</TableCell>
                <TableCell className="text-right tabular-nums">{percent(run.retrievalHits, run.questions)}</TableCell>
                <TableCell className="text-right tabular-nums">{percent(run.firstHits, run.questions)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {run.status === "ready" ? run.mrr.toLocaleString("it-IT", { maximumFractionDigits: 2 }) : "–"}
                </TableCell>
                <TableCell>
                  {run.status === "ready" && (
                    <span className="flex flex-wrap gap-1">
                      <Badge variant="success">{run.correct}</Badge>
                      <Badge variant="warning">{run.partial}</Badge>
                      <Badge variant="destructive">{run.incorrect}</Badge>
                      <Badge variant="secondary">{run.noAnswer}</Badge>
                    </span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Risultati dell'esecuzione</CardTitle>
          <CardDescription>
            Posizione della scheda attesa tra quelle recuperate e valutazione della risposta (corretta, parziale,
            errata, nessuna risposta). Apri una domanda per leggere la risposta.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RunDetail key={`${current.id}-${current.status}`} runId={current.id} />
        </CardContent>
      </Card>
    </div>
  )
}
