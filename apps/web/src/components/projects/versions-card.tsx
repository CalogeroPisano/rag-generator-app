import { useQuery } from "@tanstack/react-query"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { listVersions } from "@/functions/projects.functions"
import { formatDateTime } from "@/lib/format"

type Version = Awaited<ReturnType<typeof listVersions>>[number]

const revisionOf = (version: Version) =>
  version.commitSha !== null ? version.commitSha.slice(0, 10) : (version.contentHash?.slice(0, 10) ?? "—")

const failed = (version: Version) =>
  version.status === "failed" || version.analysisStatus === "failed" || version.understandingStatus === "failed"

function VersionState({ version, currentId }: { version: Version; currentId: string | null }) {
  if (version.id === currentId) return <Badge variant="success">In uso</Badge>
  if (failed(version)) return <Badge variant="destructive">Non riuscita</Badge>
  const complete =
    version.status === "ready" &&
    version.analysisStatus === "ready" &&
    (version.understandingStatus === null || version.understandingStatus === "ready")
  return complete ? <Badge variant="secondary">Precedente</Badge> : <Badge variant="info">In aggiornamento</Badge>
}

function Changes({ version }: { version: Version }) {
  const changes = version.changes
  if (changes === null)
    return <span className="text-muted-foreground">{version.baseSnapshotId === null ? "Prima versione" : "—"}</span>
  const { files, cards } = changes
  return (
    <span className="flex flex-col gap-0.5">
      <span>
        File: +{files.added} · ~{files.modified} · −{files.removed}
      </span>
      {cards !== null && (
        <span className="text-muted-foreground">
          Schede: {cards.kept} invariate, {cards.updated} aggiornate, {cards.created} nuove, {cards.removed} rimosse
        </span>
      )}
    </span>
  )
}

/** Versions of the code kept for the project (`SNAPSHOT_RETENTION`), newest first. */
export function VersionsCard({ projectId, currentId }: { projectId: string; currentId: string | null }) {
  const versions = useQuery({
    queryKey: ["versions", projectId],
    queryFn: () => listVersions({ data: { projectId } })
  })
  return (
    <Card>
      <CardHeader>
        <CardTitle>Versioni</CardTitle>
        <CardDescription>
          Una nuova versione diventa quella in uso al termine del suo aggiornamento; le più vecchie vengono eliminate.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {versions.data === undefined ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Revisione</TableHead>
                <TableHead>Acquisita il</TableHead>
                <TableHead>Stato</TableHead>
                <TableHead>Modifiche rispetto alla precedente</TableHead>
                <TableHead className="text-right">Schede</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {versions.data.map((version) => (
                <TableRow key={version.id}>
                  <TableCell className="font-mono text-xs">{revisionOf(version)}</TableCell>
                  <TableCell>{formatDateTime(version.createdAt)}</TableCell>
                  <TableCell>
                    <VersionState version={version} currentId={currentId} />
                  </TableCell>
                  <TableCell className="text-sm">
                    <Changes version={version} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{version.cardCount}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
