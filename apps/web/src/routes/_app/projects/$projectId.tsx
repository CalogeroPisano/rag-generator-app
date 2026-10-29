import { queryOptions, useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import {
  FileArchiveIcon,
  FlaskConicalIcon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  HashIcon,
  MessagesSquareIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  SparklesIcon
} from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { DependencyOverview } from "@/components/analysis/dependency-overview"
import { SymbolsTable } from "@/components/analysis/symbols-table"
import { FileExplorer, type FileSelection } from "@/components/file-explorer"
import { JobProgress } from "@/components/job-progress"
import { PageHeader } from "@/components/page-header"
import { DeleteProjectDialog } from "@/components/projects/delete-project-dialog"
import { NewVersionDialog } from "@/components/projects/new-version-dialog"
import { VersionsCard } from "@/components/projects/versions-card"
import { IndexStatusCard } from "@/components/rag/index-status"
import { AnalysisStatusBadge, SnapshotStatusBadge, UnderstandingStatusBadge } from "@/components/status-badge"
import { FeaturesPanel } from "@/components/understanding/features-panel"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { reanalyze } from "@/functions/analysis.functions"
import { getProject, listFiles, retryJob, stopJob } from "@/functions/projects.functions"
import { getAiStatus, startUnderstanding } from "@/functions/understanding.functions"
import { useJobStream } from "@/hooks/use-job-stream"
import { formatDateTime } from "@/lib/format"

const projectQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["project", projectId],
    queryFn: () => getProject({ data: { projectId } })
  })

const filesQuery = (snapshotId: string) =>
  queryOptions({
    queryKey: ["files", snapshotId],
    queryFn: () => listFiles({ data: { snapshotId } }),
    staleTime: Infinity
  })

export const Route = createFileRoute("/_app/projects/$projectId")({
  loader: ({ context, params }) =>
    context.queryClient.query({ ...projectQuery(params.projectId), staleTime: "static" }),
  head: ({ loaderData }) => ({
    meta: [{ title: `${loaderData?.project.name ?? "Progetto"} · Code-to-RAG` }]
  }),
  component: ProjectPage
})

function Stat({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border p-4">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold tabular-nums">{value.toLocaleString("it-IT")}</span>
      {hint !== undefined && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  )
}

type ProjectTab = "files" | "symbols" | "dependencies" | "features" | "versions"

function AnalysisPending({ status }: { status: string | null }) {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyTitle>{status === "failed" ? "Analisi statica non riuscita" : "Analisi statica in corso"}</EmptyTitle>
        <EmptyDescription>
          {status === "failed"
            ? "Riprova dal riquadro di avanzamento o con «Rianalizza»."
            : "Simboli e dipendenze saranno disponibili al termine dell'analisi."}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

function UnderstandingPending({ status }: { status: string | null }) {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyTitle>
          {status === null
            ? "Schede non ancora generate"
            : status === "failed"
              ? "Comprensione con IA non riuscita"
              : "Comprensione con IA in corso"}
        </EmptyTitle>
        <EmptyDescription>
          {status === null
            ? "Avvia «Genera schede»: il modello riassume il codice, individua le funzionalità e scrive una scheda per ciascuna."
            : status === "failed"
              ? "Riprova dal riquadro di avanzamento o con «Genera schede»."
              : "Le funzionalità e le schede saranno disponibili al termine."}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

function ProjectPage() {
  const { projectId } = Route.useParams()
  const queryClient = useQueryClient()
  const { data: summary } = useSuspenseQuery(projectQuery(projectId))
  // Pages show the version in use; a newer one is being acquired or updated meanwhile.
  const { project, currentSnapshot: snapshot, latestSnapshot: latest, latestJob: job } = summary
  const [tab, setTab] = useState<ProjectTab>("files")
  const [selection, setSelection] = useState<FileSelection | undefined>()

  // When a job ends, everything derived from the snapshot may have changed.
  const stream = useJobStream(job?.status === "succeeded" ? undefined : job?.id, String(job?.updatedAt), (ended) => {
    // A new version identical to the one in use is discarded by its acquisition.
    if (ended.type === "acquisition" && ended.status === "succeeded" && ended.progress?.message?.startsWith("Nessun")) {
      toast.info(ended.progress.message)
    }
    void queryClient.invalidateQueries()
  })

  const retry = useMutation({
    mutationFn: (jobId: string) => retryJob({ data: { jobId } }),
    onSuccess: () => {
      toast.info("Job riavviato dalla fase fallita")
      void queryClient.invalidateQueries({ queryKey: ["project", projectId] })
    },
    onError: (error) => toast.error(error.message)
  })

  const stop = useMutation({
    mutationFn: (jobId: string) => stopJob({ data: { jobId } }),
    onSuccess: () => {
      toast.info("Operazione interrotta")
      void queryClient.invalidateQueries()
    },
    onError: (error) => toast.error(error.message)
  })

  const startAnalysis = useMutation({
    mutationFn: (snapshotId: string) => reanalyze({ data: { snapshotId } }),
    onSuccess: () => {
      toast.info("Analisi statica avviata")
      void queryClient.invalidateQueries({ queryKey: ["project", projectId] })
    },
    onError: (error) => toast.error(error.message)
  })

  const generateCards = useMutation({
    mutationFn: (snapshotId: string) => startUnderstanding({ data: { snapshotId } }),
    onSuccess: () => {
      toast.info("Comprensione con IA avviata")
      void queryClient.invalidateQueries({ queryKey: ["project", projectId] })
    },
    onError: (error) => toast.error(error.message)
  })
  const ai = useQuery({ queryKey: ["ai-status"], queryFn: () => getAiStatus(), staleTime: 60_000 })

  const readySnapshot = snapshot?.status === "ready" ? snapshot : null
  const analysisReady = readySnapshot?.analysisStatus === "ready"
  const understandingReady = readySnapshot?.understandingStatus === "ready"
  const jobActive = job !== null && (job.status === "queued" || job.status === "running")
  const newVersionPending =
    latest !== null &&
    latest.id !== snapshot?.id &&
    latest.status !== "failed" &&
    latest.analysisStatus !== "failed" &&
    latest.understandingStatus !== "failed"
  const files = useQuery({ ...filesQuery(readySnapshot?.id ?? ""), enabled: readySnapshot !== null })

  const openFile = (next: FileSelection) => {
    setSelection(next)
    setTab("files")
  }

  return (
    <>
      <PageHeader
        title={project.name}
        breadcrumbs={[{ label: "Progetti", to: "/projects" }, { label: project.name }]}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">
              {project.sourceType === "git" ? <GitBranchIcon /> : <FileArchiveIcon />}
              {project.sourceType === "git" ? "Git" : "Zip"}
            </Badge>
            {project.repositoryUrl !== null && <span className="truncate">{project.repositoryUrl}</span>}
            {project.repositoryRef !== null && <Badge variant="secondary">{project.repositoryRef}</Badge>}
            <span>Creato il {formatDateTime(project.createdAt)}</span>
          </span>
        }
        actions={
          <>
            {snapshot !== null && <SnapshotStatusBadge status={snapshot.status} />}
            {snapshot?.understandingStatus === "ready" && (
              <>
                <Button variant="outline" size="sm" asChild>
                  <Link to="/projects/$projectId/tests" params={{ projectId }}>
                    <FlaskConicalIcon data-icon="inline-start" />
                    Domande di test
                  </Link>
                </Button>
                <Button size="sm" asChild>
                  <Link to="/projects/$projectId/chat" params={{ projectId }}>
                    <MessagesSquareIcon data-icon="inline-start" />
                    Chat
                  </Link>
                </Button>
              </>
            )}
            <NewVersionDialog
              projectId={project.id}
              sourceType={project.sourceType}
              repositoryRef={project.repositoryRef}
              hasCards={understandingReady}
              disabled={readySnapshot === null || (jobActive && job.type !== "indexing")}
            />
            <DeleteProjectDialog
              projectId={project.id}
              projectName={project.name}
              disabled={job !== null && job.status === "running"}
            />
          </>
        }
      />

      {newVersionPending && (
        <Alert>
          <AlertTitle>Nuova versione in elaborazione</AlertTitle>
          <AlertDescription>
            Fino al termine dell'aggiornamento restano in uso la versione attuale, la chat e i test; revisione e
            correzioni delle schede riprendono alla fine.
          </AlertDescription>
        </Alert>
      )}

      {job !== null && job.status !== "succeeded" && (
        <JobProgress
          stream={stream}
          onRetry={() => retry.mutate(job.id)}
          retrying={retry.isPending}
          onCancel={() => stop.mutate(job.id)}
          cancelling={stop.isPending}
        />
      )}

      {readySnapshot !== null && (
        <Card>
          <CardHeader>
            <CardTitle>Versione acquisita</CardTitle>
            <CardDescription className="flex items-center gap-2 font-mono text-xs">
              {readySnapshot.commitSha !== null ? (
                <>
                  <GitCommitHorizontalIcon className="size-4" /> {readySnapshot.commitSha}
                </>
              ) : (
                <>
                  <HashIcon className="size-4" /> {readySnapshot.contentHash}
                </>
              )}
            </CardDescription>
            <CardAction className="flex items-center gap-2">
              {readySnapshot.analysisStatus !== null && <AnalysisStatusBadge status={readySnapshot.analysisStatus} />}
              {readySnapshot.understandingStatus !== null && (
                <UnderstandingStatusBadge status={readySnapshot.understandingStatus} />
              )}
              <Button
                variant="outline"
                size="sm"
                disabled={jobActive || newVersionPending || startAnalysis.isPending}
                onClick={() => startAnalysis.mutate(readySnapshot.id)}
              >
                {startAnalysis.isPending ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <RefreshCwIcon data-icon="inline-start" />
                )}
                Rianalizza
              </Button>
              <Tooltip>
                <TooltipTrigger asChild>
                  {/* A span keeps the tooltip working on a disabled button. */}
                  <span>
                    <Button
                      size="sm"
                      disabled={
                        !analysisReady ||
                        jobActive ||
                        newVersionPending ||
                        generateCards.isPending ||
                        ai.data?.configured !== true
                      }
                      onClick={() => generateCards.mutate(readySnapshot.id)}
                    >
                      {generateCards.isPending ? (
                        <Spinner data-icon="inline-start" />
                      ) : (
                        <SparklesIcon data-icon="inline-start" />
                      )}
                      {understandingReady ? "Rigenera schede" : "Genera schede"}
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {ai.data?.configured === false
                    ? "Modello IA non configurato (AI_MODEL)"
                    : !analysisReady
                      ? "Disponibile al termine dell'analisi statica"
                      : `Riassunti, mappa delle funzionalità e schede con ${ai.data?.model ?? "il modello configurato"}`}
                </TooltipContent>
              </Tooltip>
            </CardAction>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-3 lg:grid-cols-7">
            <Stat label="File analizzati" value={readySnapshot.includedFiles} />
            <Stat
              label="Voci escluse"
              value={readySnapshot.excludedFiles}
              hint="Dipendenze, build, binari, file generati o sensibili"
            />
            <Stat label="Credenziali mascherate" value={readySnapshot.maskedSecrets} hint="Prima di ogni salvataggio" />
            <Stat label="Simboli" value={readySnapshot.symbolCount} hint="Classi, funzioni, costanti…" />
            <Stat label="Dipendenze" value={readySnapshot.dependencyCount} hint="Import tra file e verso librerie" />
            <Stat label="Funzionalità" value={readySnapshot.featureCount} hint="Individuate dall'IA" />
            <Stat label="Schede" value={readySnapshot.cardCount} hint="Una per funzionalità" />
          </CardContent>
        </Card>
      )}

      {readySnapshot !== null && (
        <Tabs value={tab} onValueChange={(value) => setTab(value as ProjectTab)} className="gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <TabsList>
              <TabsTrigger value="files">File</TabsTrigger>
              <TabsTrigger value="symbols">Simboli</TabsTrigger>
              <TabsTrigger value="dependencies">Dipendenze</TabsTrigger>
              <TabsTrigger value="features">Funzionalità</TabsTrigger>
              <TabsTrigger value="versions">Versioni</TabsTrigger>
            </TabsList>
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <ShieldCheckIcon className="size-3.5" /> Contenuto mostrato già mascherato
            </span>
          </div>
          <TabsContent value="files">
            {files.data === undefined ? (
              <Skeleton className="h-[70vh] w-full" />
            ) : (
              <FileExplorer
                snapshotId={readySnapshot.id}
                entries={files.data}
                analysisReady={analysisReady}
                understandingReady={understandingReady}
                selection={selection}
                onSelectionChange={setSelection}
              />
            )}
          </TabsContent>
          <TabsContent value="symbols">
            {analysisReady ? (
              <SymbolsTable
                snapshotId={readySnapshot.id}
                onOpen={(path, startLine, endLine) =>
                  openFile({ path, focus: { startLine, endLine, key: Date.now() } })
                }
              />
            ) : (
              <AnalysisPending status={readySnapshot.analysisStatus} />
            )}
          </TabsContent>
          <TabsContent value="dependencies">
            {analysisReady ? (
              <DependencyOverview snapshotId={readySnapshot.id} onOpenFile={(path) => openFile({ path })} />
            ) : (
              <AnalysisPending status={readySnapshot.analysisStatus} />
            )}
          </TabsContent>
          <TabsContent value="features" className="flex flex-col gap-4">
            {understandingReady && <IndexStatusCard snapshotId={readySnapshot.id} projectId={projectId} />}
            {understandingReady ? (
              <FeaturesPanel
                projectId={projectId}
                snapshotId={readySnapshot.id}
                onOpenReference={(path, startLine, endLine) =>
                  openFile({ path, focus: { startLine, endLine, key: Date.now() } })
                }
                onOpenFile={(path) => openFile({ path })}
              />
            ) : (
              <UnderstandingPending status={readySnapshot.understandingStatus} />
            )}
          </TabsContent>
          <TabsContent value="versions">
            <VersionsCard projectId={projectId} currentId={readySnapshot.id} />
          </TabsContent>
        </Tabs>
      )}
    </>
  )
}
