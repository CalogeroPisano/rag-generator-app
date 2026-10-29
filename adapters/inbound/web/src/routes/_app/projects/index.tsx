import { queryOptions, useSuspenseQuery } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { FileArchiveIcon, FolderGit2Icon, GitBranchIcon, PlusIcon } from "lucide-react"
import { PageHeader } from "@/components/page-header"
import { JobStatusBadge, SnapshotStatusBadge } from "@/components/status-badge"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { listProjects } from "@/functions/projects.functions"
import { formatDateTime } from "@/lib/format"

export const projectsQuery = queryOptions({
  queryKey: ["projects"],
  queryFn: () => listProjects(),
  // Poll while something is being acquired, so statuses update on their own.
  refetchInterval: (query) =>
    query.state.data?.some(
      (summary) => summary.latestJob?.status === "queued" || summary.latestJob?.status === "running"
    )
      ? 3000
      : false
})

export const Route = createFileRoute("/_app/projects/")({
  loader: ({ context }) =>
    context.queryClient.query({ queryKey: projectsQuery.queryKey, queryFn: () => listProjects(), staleTime: "static" }),
  head: () => ({ meta: [{ title: "Progetti · Code-to-RAG" }] }),
  component: ProjectsPage
})

function ProjectsPage() {
  const { data: projects } = useSuspenseQuery(projectsQuery)

  const newProjectButton = (
    <Button asChild>
      <Link to="/projects/new">
        <PlusIcon data-icon="inline-start" /> Nuovo progetto
      </Link>
    </Button>
  )

  return (
    <>
      <PageHeader
        title="Progetti"
        description="Codice sorgente acquisito da archivi zip o repository Git."
        actions={projects.length > 0 ? newProjectButton : undefined}
      />
      {projects.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderGit2Icon />
            </EmptyMedia>
            <EmptyTitle>Nessun progetto</EmptyTitle>
            <EmptyDescription>
              Carica un archivio zip o collega un repository Git per iniziare l'analisi.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>{newProjectButton}</EmptyContent>
        </Empty>
      ) : (
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nome</TableHead>
                <TableHead>Sorgente</TableHead>
                <TableHead>Stato</TableHead>
                <TableHead className="text-right">File analizzati</TableHead>
                <TableHead className="text-right">Esclusi</TableHead>
                <TableHead>Creato</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {projects.map(({ project, latestSnapshot, latestJob }) => (
                <TableRow key={project.id}>
                  <TableCell className="font-medium">
                    <Link to="/projects/$projectId" params={{ projectId: project.id }} className="hover:underline">
                      {project.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <div className="flex min-w-0 items-center gap-2">
                      <Badge variant="outline">
                        {project.sourceType === "git" ? <GitBranchIcon /> : <FileArchiveIcon />}
                        {project.sourceType === "git" ? "Git" : "Zip"}
                      </Badge>
                      {project.repositoryUrl !== null && (
                        <span className="max-w-64 truncate text-xs text-muted-foreground">{project.repositoryUrl}</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    {latestJob !== null && latestJob.status !== "succeeded" ? (
                      <JobStatusBadge status={latestJob.status} />
                    ) : latestSnapshot !== null ? (
                      <SnapshotStatusBadge status={latestSnapshot.status} />
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{latestSnapshot?.includedFiles ?? 0}</TableCell>
                  <TableCell className="text-right text-muted-foreground tabular-nums">
                    {latestSnapshot?.excludedFiles ?? 0}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{formatDateTime(project.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </>
  )
}
