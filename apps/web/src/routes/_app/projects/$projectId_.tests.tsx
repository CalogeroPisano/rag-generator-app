import { queryOptions, useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { MessagesSquareIcon, PencilIcon, PlayIcon, PlusIcon, SparklesIcon, Trash2Icon } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { PageHeader } from "@/components/page-header"
import { QuestionDialog } from "@/components/tests/question-dialog"
import { TestRuns } from "@/components/tests/test-runs"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { getProject } from "@/functions/projects.functions"
import {
  getRagStatus,
  listRagJobs,
  listTestQuestions,
  removeTestQuestion,
  startQuestionGeneration,
  startTestRun
} from "@/functions/rag.functions"
import { getFeatureMap } from "@/functions/understanding.functions"

const projectQuery = (projectId: string) =>
  queryOptions({ queryKey: ["project", projectId], queryFn: () => getProject({ data: { projectId } }) })

export const Route = createFileRoute("/_app/projects/$projectId_/tests")({
  loader: ({ context, params }) =>
    context.queryClient.query({ ...projectQuery(params.projectId), staleTime: "static" }),
  head: () => ({ meta: [{ title: "Domande di test · Code-to-RAG" }] }),
  component: TestsPage
})

function TestsPage() {
  const { projectId } = Route.useParams()
  const { data: summary } = useSuspenseQuery(projectQuery(projectId))
  const snapshot = summary.latestSnapshot
  return (
    <>
      <PageHeader
        title="Domande di test"
        breadcrumbs={[
          { label: "Progetti", to: "/projects" },
          { label: summary.project.name, to: "/projects/$projectId", params: { projectId } },
          { label: "Domande di test" }
        ]}
        description="Domande che un utente potrebbe fare alla chat, con la scheda che contiene la risposta."
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link to="/projects/$projectId/chat" params={{ projectId }}>
              <MessagesSquareIcon data-icon="inline-start" />
              Chat
            </Link>
          </Button>
        }
      />
      {snapshot === null || snapshot.understandingStatus !== "ready" ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>Schede non ancora disponibili</EmptyTitle>
            <EmptyDescription>
              Le domande di test si riferiscono alle schede: genera le schede del progetto.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Tests projectId={projectId} snapshotId={snapshot.id} />
      )}
    </>
  )
}

const jobLabels: Record<string, string> = {
  indexing: "Indicizzazione",
  questions: "Generazione delle domande",
  evaluation: "Esecuzione dei test"
}

function Tests({ projectId, snapshotId }: { projectId: string; snapshotId: string }) {
  const queryClient = useQueryClient()
  const [approvedOnly, setApprovedOnly] = useState(false)
  const rag = useQuery({ queryKey: ["rag-status"], queryFn: () => getRagStatus(), staleTime: 60_000 })
  const map = useQuery({
    queryKey: ["feature-map", snapshotId],
    queryFn: () => getFeatureMap({ data: { snapshotId } })
  })
  const questions = useQuery({
    queryKey: ["test-questions", snapshotId],
    queryFn: () => listTestQuestions({ data: { snapshotId } })
  })
  // Jobs run in the worker: poll while one is active, refresh questions and runs when they end.
  const jobs = useQuery({
    queryKey: ["rag-jobs", projectId],
    queryFn: () => listRagJobs({ data: { projectId } }),
    refetchInterval: (query) => ((query.state.data?.length ?? 0) > 0 ? 3000 : false)
  })
  const active = jobs.data ?? []
  const generating = active.some((job) => job.type === "questions")
  const running = active.some((job) => job.type === "evaluation")
  const wasActive = useRef(false)
  useEffect(() => {
    if (wasActive.current && active.length === 0) {
      void queryClient.invalidateQueries({ queryKey: ["test-questions", snapshotId] })
      void queryClient.invalidateQueries({ queryKey: ["test-runs", snapshotId] })
      void queryClient.invalidateQueries({ queryKey: ["test-run"] })
    }
    wasActive.current = active.length > 0
  }, [active.length, queryClient, snapshotId])

  const onJob = (message: string) => () => {
    toast.info(message)
    void queryClient.invalidateQueries({ queryKey: ["rag-jobs", projectId] })
    void queryClient.invalidateQueries({ queryKey: ["test-runs", snapshotId] })
  }
  const generate = useMutation({
    mutationFn: () => startQuestionGeneration({ data: { snapshotId } }),
    onSuccess: onJob("Generazione delle domande avviata"),
    onError: (error) => toast.error(error.message)
  })
  const run = useMutation({
    mutationFn: () => startTestRun({ data: { snapshotId, approvedOnly } }),
    onSuccess: onJob("Esecuzione dei test avviata"),
    onError: (error) => toast.error(error.message)
  })
  const remove = useMutation({
    mutationFn: (questionId: string) => removeTestQuestion({ data: { snapshotId, questionId } }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["test-questions", snapshotId] }),
    onError: (error) => toast.error(error.message)
  })

  const features = (map.data?.features ?? []).filter((f) => f.card !== null)
  const featureNames = new Map(features.map((f) => [f.id, f.name]))
  const modelsReady = rag.data?.chatModel !== null && rag.data?.embeddingModel !== null
  const list = questions.data ?? []
  const groups = [
    ...features.map((f) => ({ key: f.id, name: f.name, items: list.filter((q) => q.featureId === f.id) })),
    {
      key: "orphans",
      name: "Funzionalità non più presenti",
      items: list.filter((q) => q.featureId === null || !featureNames.has(q.featureId))
    }
  ].filter((group) => group.items.length > 0)

  return (
    <div className="flex flex-col gap-4">
      {rag.data !== undefined && !modelsReady && (
        <Alert variant="destructive">
          <AlertTitle>Modelli non configurati</AlertTitle>
          <AlertDescription>
            Generazione ed esecuzione dei test richiedono AI_MODEL ed EMBEDDING_MODEL sul server.
          </AlertDescription>
        </Alert>
      )}
      {active.map((job) => (
        <Alert key={job.id}>
          <Spinner />
          <AlertTitle>
            {jobLabels[job.type] ?? job.type}: {job.status === "queued" ? "in coda" : "in corso"}
          </AlertTitle>
          {job.progress?.message != null && <AlertDescription>{job.progress.message}</AlertDescription>}
        </Alert>
      ))}
      <Tabs defaultValue="questions" className="gap-3">
        <TabsList>
          <TabsTrigger value="questions">Domande ({list.length})</TabsTrigger>
          <TabsTrigger value="runs">Esecuzioni</TabsTrigger>
        </TabsList>
        <TabsContent value="questions" className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            <QuestionDialog
              snapshotId={snapshotId}
              features={features}
              initial={{ id: null, featureId: "", question: "", expectedAnswer: "" }}
              trigger={
                <Button size="sm" disabled={features.length === 0}>
                  <PlusIcon data-icon="inline-start" />
                  Aggiungi domanda
                </Button>
              }
            />
            <Button
              size="sm"
              variant="outline"
              disabled={!modelsReady || generating || generate.isPending}
              onClick={() => generate.mutate()}
            >
              {generating || generate.isPending ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <SparklesIcon data-icon="inline-start" />
              )}
              Genera domande
            </Button>
          </div>
          {questions.data === undefined ? (
            <Skeleton className="h-48 w-full" />
          ) : groups.length === 0 ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyTitle>Nessuna domanda di test</EmptyTitle>
                <EmptyDescription>
                  «Genera domande» ne scrive alcune per ogni scheda (con la risposta attesa); puoi anche aggiungerne di
                  tue.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            groups.map((group) => (
              <Card key={group.key} className="gap-2">
                <CardHeader>
                  <CardTitle className="text-base">{group.name}</CardTitle>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-1/2">Domanda</TableHead>
                        <TableHead>Risposta attesa</TableHead>
                        <TableHead className="w-28">Origine</TableHead>
                        <TableHead className="w-20" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {group.items.map((q) => (
                        <TableRow key={q.id}>
                          <TableCell className="align-top whitespace-normal">{q.question}</TableCell>
                          <TableCell className="align-top whitespace-normal text-muted-foreground">
                            {q.expectedAnswer ?? "–"}
                          </TableCell>
                          <TableCell className="align-top">
                            {q.origin === "generated" ? (
                              <Badge variant="info">Generata</Badge>
                            ) : (
                              <Badge variant="outline" title={q.authorName ?? undefined}>
                                Manuale
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell className="align-top">
                            <div className="flex justify-end gap-1">
                              <QuestionDialog
                                snapshotId={snapshotId}
                                features={features}
                                initial={{
                                  id: q.id,
                                  featureId: q.featureId !== null && featureNames.has(q.featureId) ? q.featureId : "",
                                  question: q.question,
                                  expectedAnswer: q.expectedAnswer ?? ""
                                }}
                                trigger={
                                  <Button variant="ghost" size="icon" className="size-7" aria-label="Modifica">
                                    <PencilIcon />
                                  </Button>
                                }
                              />
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-7"
                                aria-label="Elimina"
                                disabled={remove.isPending}
                                onClick={() => remove.mutate(q.id)}
                              >
                                <Trash2Icon />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            ))
          )}
        </TabsContent>
        <TabsContent value="runs" className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Esegui i test</CardTitle>
              <CardDescription>
                Ogni domanda (delle schede non escluse) viene posta alla chat senza cronologia. Su CPU può richiedere
                molto tempo: una risposta e una valutazione per domanda.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center gap-4">
              <Button
                size="sm"
                disabled={!modelsReady || running || run.isPending || list.length === 0}
                onClick={() => run.mutate()}
              >
                {running || run.isPending ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <PlayIcon data-icon="inline-start" />
                )}
                Esegui i test
              </Button>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="run-approved-only"
                  checked={approvedOnly}
                  onCheckedChange={(checked) => setApprovedOnly(checked === true)}
                />
                <Label htmlFor="run-approved-only" className="font-normal">
                  Solo schede approvate
                </Label>
              </div>
            </CardContent>
          </Card>
          <TestRuns snapshotId={snapshotId} polling={running} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
