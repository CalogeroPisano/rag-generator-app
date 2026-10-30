import { queryOptions, useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import {
  BanIcon,
  CheckIcon,
  MessageSquareWarningIcon,
  PencilIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SearchCheckIcon
} from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import type { CodeFocus } from "@/components/code/code-viewer.client"
import { PageHeader } from "@/components/page-header"
import { CardEditor, type CardDraft, fromDraft, toDraft } from "@/components/review/card-editor"
import { CardReview } from "@/components/review/card-review"
import { CodePane } from "@/components/review/code-pane"
import { allReferences, type Reference } from "@/components/review/statements"
import { CardStatusBadge } from "@/components/status-badge"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from "@/components/ui/dialog"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { getProject } from "@/functions/projects.functions"
import {
  changeCardStatus,
  listCardJobs,
  saveCardEdit,
  startCardOperation,
  submitCorrection
} from "@/functions/review.functions"
import { getCard, getFeatureMap } from "@/functions/understanding.functions"
import { formatDateTime } from "@/lib/format"

const projectQuery = (projectId: string) =>
  queryOptions({ queryKey: ["project", projectId], queryFn: () => getProject({ data: { projectId } }) })

export const Route = createFileRoute("/_app/projects/$projectId_/cards/$featureId")({
  loader: ({ context, params }) =>
    context.queryClient.query({ ...projectQuery(params.projectId), staleTime: "static" }),
  head: () => ({ meta: [{ title: "Revisione scheda · Code-to-RAG" }] }),
  component: ReviewPage
})

const operationLabels = {
  verify: "Verifica in corso",
  regenerate: "Rigenerazione in corso",
  generate: "Generazione in corso",
  correct: "Correzione in corso"
}

function ReviewPage() {
  const { projectId, featureId } = Route.useParams()
  const { data: summary } = useSuspenseQuery(projectQuery(projectId))
  const snapshotId = summary.currentSnapshot?.id
  if (snapshotId === undefined) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle>Nessuna versione acquisita</EmptyTitle>
        </EmptyHeader>
      </Empty>
    )
  }
  // A new version being acquired or updated copies these cards: changes are refused until it is done.
  const latest = summary.latestSnapshot
  const updating =
    latest !== null &&
    latest.id !== snapshotId &&
    latest.status !== "failed" &&
    latest.analysisStatus !== "failed" &&
    latest.understandingStatus !== "failed"
  return (
    <Review
      projectId={projectId}
      projectName={summary.project.name}
      snapshotId={snapshotId}
      featureId={featureId}
      updating={updating}
    />
  )
}

function Review({
  projectId,
  projectName,
  snapshotId,
  featureId,
  updating
}: {
  projectId: string
  projectName: string
  snapshotId: string
  featureId: string
  updating: boolean
}) {
  const queryClient = useQueryClient()
  const map = useQuery({
    queryKey: ["feature-map", snapshotId],
    queryFn: () => getFeatureMap({ data: { snapshotId } })
  })
  const feature = map.data?.features.find((f) => f.id === featureId)
  const cardId = feature?.card?.id
  const card = useQuery({
    queryKey: ["card", snapshotId, cardId],
    queryFn: () => getCard({ data: { snapshotId, cardId: cardId! } }),
    enabled: cardId !== undefined
  })

  // Model operations run in the worker: poll while one is active for this feature, refresh when it ends.
  const jobs = useQuery({
    queryKey: ["card-jobs", projectId],
    queryFn: () => listCardJobs({ data: { projectId } }),
    refetchInterval: (query) => ((query.state.data ?? []).some((job) => job.featureId === featureId) ? 4000 : false)
  })
  const activeJob = jobs.data?.find((job) => job.featureId === featureId)
  const wasActive = useRef(false)
  useEffect(() => {
    if (activeJob !== undefined) wasActive.current = true
    else if (wasActive.current) {
      wasActive.current = false
      void queryClient.invalidateQueries({ queryKey: ["feature-map", snapshotId] })
      void queryClient.invalidateQueries({ queryKey: ["card", snapshotId] })
      void queryClient.invalidateQueries({ queryKey: ["project", projectId] })
      toast.success("Operazione sulla scheda completata")
    }
  }, [activeJob, queryClient, snapshotId, projectId])

  const [selected, setSelected] = useState<string | undefined>()
  const [path, setPath] = useState<string | undefined>()
  const [focus, setFocus] = useState<CodeFocus | undefined>()
  const [draft, setDraft] = useState<CardDraft | null>(null)
  const [correction, setCorrection] = useState("")
  const [correctionOpen, setCorrectionOpen] = useState(false)

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["card", snapshotId] })
    void queryClient.invalidateQueries({ queryKey: ["feature-map", snapshotId] })
  }
  const onError = (error: Error) => toast.error(error.message)
  const status = useMutation({
    mutationFn: (next: "approved" | "excluded" | "in_review") =>
      changeCardStatus({ data: { snapshotId, cardId: cardId!, status: next } }),
    onSuccess: refresh,
    onError
  })
  const operation = useMutation({
    mutationFn: (op: "verify" | "regenerate") =>
      startCardOperation({ data: { snapshotId, cardId: cardId!, operation: op } }),
    onSuccess: () => {
      toast.info("Operazione avviata: il modello sta lavorando")
      void jobs.refetch()
    },
    onError
  })
  const correct = useMutation({
    mutationFn: (text: string) => submitCorrection({ data: { snapshotId, cardId: cardId!, text } }),
    onSuccess: () => {
      setCorrection("")
      setCorrectionOpen(false)
      toast.info("Correzione registrata: il modello aggiorna la scheda")
      void jobs.refetch()
    },
    onError
  })
  const save = useMutation({
    mutationFn: (next: CardDraft) => saveCardEdit({ data: { snapshotId, cardId: cardId!, content: fromDraft(next) } }),
    onSuccess: () => {
      setDraft(null)
      toast.success("Scheda salvata")
      refresh()
    },
    onError
  })

  if (map.data !== undefined && (feature === undefined || cardId === undefined)) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle>Scheda non trovata</EmptyTitle>
          <EmptyDescription>
            La funzionalità non esiste più o non ha una scheda: rigenera le schede del progetto.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  if (card.data === undefined || feature === undefined) return <Skeleton className="h-[80vh] w-full" />
  const data = card.data
  const files = [...new Set([...data.feature.files, ...allReferences(data.content).map((r) => r.path)])]
  const shownPath = path ?? files[0]
  const busy = activeJob !== undefined
  const pending = status.isPending || operation.isPending || correct.isPending || save.isPending || updating

  const select = (statementId: string, reference: Reference | undefined) => {
    setSelected(statementId)
    if (reference === undefined) return
    setPath(reference.path)
    setFocus({ startLine: reference.startLine, endLine: reference.endLine, key: Date.now() })
  }

  return (
    <>
      <PageHeader
        title={data.content.title}
        breadcrumbs={[
          { label: "Progetti", to: "/projects" },
          { label: projectName, to: "/projects/$projectId", params: { projectId } },
          { label: data.feature.name }
        ]}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <CardStatusBadge status={data.status} />
            <Badge variant="outline">Versione {data.version}</Badge>
            <span>
              {data.model} · {formatDateTime(data.updatedAt)}
              {data.reviewedBy !== null && data.reviewedAt !== null && (
                <>
                  {" "}
                  · revisione di {data.reviewedBy}, {formatDateTime(data.reviewedAt)}
                </>
              )}
            </span>
          </span>
        }
        actions={
          draft === null ? (
            <div className="flex flex-wrap gap-2">
              {updating && <Badge variant="info">Aggiornamento alla nuova versione in corso</Badge>}
              {busy && (
                <Badge variant="info">
                  <Spinner data-icon="inline-start" />
                  {operationLabels[activeJob.operation]}
                </Badge>
              )}
              {data.status === "approved" || data.status === "excluded" ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || pending}
                  onClick={() => status.mutate("in_review")}
                >
                  <RotateCcwIcon data-icon="inline-start" />
                  Riapri
                </Button>
              ) : (
                <>
                  <Button size="sm" disabled={busy || pending} onClick={() => status.mutate("approved")}>
                    <CheckIcon data-icon="inline-start" />
                    Approva
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || pending}
                    onClick={() => status.mutate("excluded")}
                  >
                    <BanIcon data-icon="inline-start" />
                    Escludi
                  </Button>
                </>
              )}
              <Button
                variant="outline"
                size="sm"
                disabled={busy || pending}
                onClick={() => setDraft(toDraft(data.content))}
              >
                <PencilIcon data-icon="inline-start" />
                Modifica
              </Button>
              <Dialog open={correctionOpen} onOpenChange={setCorrectionOpen}>
                <DialogTrigger asChild>
                  <Button variant="outline" size="sm" disabled={busy || pending}>
                    <MessageSquareWarningIcon data-icon="inline-start" />
                    Correggi con l'IA
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Correzione assistita</DialogTitle>
                    <DialogDescription>
                      Descrivi l'errore: il modello aggiorna la scheda ricontrollando il codice. La correzione resta
                      salvata e viene riapplicata a ogni rigenerazione.
                    </DialogDescription>
                  </DialogHeader>
                  <Textarea
                    autoFocus
                    rows={5}
                    placeholder="Es.: il limite massimo è 50 pezzi, non 100; manca l'errore mostrato quando…"
                    value={correction}
                    onChange={(event) => setCorrection(event.target.value)}
                  />
                  <DialogFooter>
                    <Button
                      disabled={correction.trim().length < 3 || correct.isPending}
                      onClick={() => correct.mutate(correction)}
                    >
                      {correct.isPending && <Spinner data-icon="inline-start" />}
                      Invia correzione
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
              <Button variant="outline" size="sm" disabled={busy || pending} onClick={() => operation.mutate("verify")}>
                <SearchCheckIcon data-icon="inline-start" />
                Verifica
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" size="sm" disabled={busy || pending}>
                    <RefreshCwIcon data-icon="inline-start" />
                    Rigenera
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Rigenerare la scheda?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Il modello riscrive la scheda da zero leggendo il codice e applicando le correzioni salvate. Le
                      modifiche manuali e l'approvazione vanno perse.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Annulla</AlertDialogCancel>
                    <AlertDialogAction onClick={() => operation.mutate("regenerate")}>Rigenera</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          ) : (
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={save.isPending} onClick={() => setDraft(null)}>
                Annulla
              </Button>
              <Button
                size="sm"
                disabled={save.isPending || draft.title.trim() === ""}
                onClick={() => save.mutate(draft)}
              >
                {save.isPending && <Spinner data-icon="inline-start" />}
                Salva
              </Button>
            </div>
          )
        }
      />

      <div className="grid gap-4 lg:h-[calc(100vh-11rem)] lg:grid-cols-2">
        <Card className="min-h-0 py-0">
          <ScrollArea className="h-full">
            <div className="flex flex-col gap-6 p-4">
              {draft === null ? (
                <CardReview card={data} selected={selected} onSelect={select} />
              ) : (
                <CardEditor draft={draft} onChange={setDraft} files={files} currentPath={shownPath} />
              )}
              {data.corrections.length > 0 && (
                <section className="flex flex-col gap-2 text-sm">
                  <h3 className="font-medium">Correzioni del revisore</h3>
                  <ul className="flex flex-col gap-2">
                    {data.corrections.map((item) => (
                      <li key={item.id} className="rounded-md border p-3">
                        <p className="whitespace-pre-wrap">{item.text}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {item.authorName} · {formatDateTime(item.createdAt)} ·{" "}
                          {item.appliedVersion === null
                            ? "in attesa di applicazione"
                            : `applicata nella versione ${item.appliedVersion}`}
                        </p>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          </ScrollArea>
        </Card>
        <Card className="h-[70vh] min-h-0 overflow-hidden py-0 lg:h-auto">
          <CodePane
            snapshotId={snapshotId}
            files={files}
            path={shownPath}
            onPathChange={setPath}
            references={allReferences(draft === null ? data.content : fromDraft(draft))}
            focus={focus}
          />
        </Card>
      </div>
    </>
  )
}
