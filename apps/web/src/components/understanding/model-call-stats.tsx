import { useQuery } from "@tanstack/react-query"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { getModelCallStats } from "@/functions/understanding.functions"
import { formatDuration } from "@/lib/format"

const taskLabels: Record<string, string> = {
  "file-summary": "Riassunti dei file",
  "file-rollup": "Riassunti di file grandi",
  "module-summary": "Riassunti dei moduli",
  "feature-map": "Mappa delle funzionalità",
  "feature-merge": "Unione delle funzionalità",
  card: "Schede"
}

const number = (value: number) => value.toLocaleString("it-IT")

/** Model call log of a snapshot: calls, tokens and time per task (no content is ever stored). */
export function ModelCallStats({ snapshotId }: { snapshotId: string }) {
  const stats = useQuery({
    queryKey: ["model-calls", snapshotId],
    queryFn: () => getModelCallStats({ data: { snapshotId } })
  })
  if (stats.data === undefined) return <Skeleton className="h-48 w-full" />
  const { total, byTask, models } = stats.data
  return (
    <Card>
      <CardHeader>
        <CardTitle>Chiamate al modello</CardTitle>
        <CardDescription>
          {models.length === 0 ? "Nessuna chiamata registrata." : `Modello: ${models.join(", ")}.`} Il registro contiene
          solo fase, durata, token ed esito: mai il codice.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Attività</TableHead>
              <TableHead className="text-right">Chiamate</TableHead>
              <TableHead className="text-right">Non riuscite</TableHead>
              <TableHead className="text-right">Token in / out</TableHead>
              <TableHead className="text-right">Tempo</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {byTask.map((row) => (
              <TableRow key={row.task}>
                <TableCell>{taskLabels[row.task] ?? row.task}</TableCell>
                <TableCell className="text-right tabular-nums">{number(row.calls)}</TableCell>
                <TableCell className="text-right tabular-nums">{number(row.failures)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {number(row.inputTokens)} / {number(row.outputTokens)}
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatDuration(row.durationMs)}</TableCell>
              </TableRow>
            ))}
            <TableRow className="font-medium">
              <TableCell>Totale</TableCell>
              <TableCell className="text-right tabular-nums">{number(total.calls)}</TableCell>
              <TableCell className="text-right tabular-nums">{number(total.failures)}</TableCell>
              <TableCell className="text-right tabular-nums">
                {number(total.inputTokens)} / {number(total.outputTokens)}
              </TableCell>
              <TableCell className="text-right tabular-nums">{formatDuration(total.durationMs)}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
