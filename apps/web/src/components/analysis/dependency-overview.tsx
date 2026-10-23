import { useQuery } from "@tanstack/react-query"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { getDependencyOverview } from "@/functions/analysis.functions"
import { targetKindLabels } from "./labels"

/** Snapshot-wide view of the analysis: languages, dependency kinds, libraries and most used files. */
export function DependencyOverview({
  snapshotId,
  onOpenFile
}: {
  snapshotId: string
  onOpenFile: (path: string) => void
}) {
  const overview = useQuery({
    queryKey: ["dependency-overview", snapshotId],
    queryFn: () => getDependencyOverview({ data: { snapshotId } }),
    staleTime: Infinity
  })

  if (overview.data === undefined) return <Skeleton className="h-96 w-full" />
  const { languages, byTargetKind, externals, hubs } = overview.data

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Linguaggi analizzati</CardTitle>
          <CardDescription>File elaborati con tree-sitter e dichiarazioni trovate.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Linguaggio</TableHead>
                <TableHead className="text-right">File</TableHead>
                <TableHead className="text-right">Simboli</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {languages.map((row) => (
                <TableRow key={row.language}>
                  <TableCell className="capitalize">{row.language}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.files.toLocaleString("it-IT")}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.symbols.toLocaleString("it-IT")}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Dipendenze per destinazione</CardTitle>
          <CardDescription>Import interni al progetto, verso librerie esterne o non risolti.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {byTargetKind.map((row) => (
            <Badge key={row.targetKind} variant={row.targetKind === "unresolved" ? "warning" : "outline"}>
              {targetKindLabels[row.targetKind].label}: {row.count.toLocaleString("it-IT")}
            </Badge>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Librerie esterne</CardTitle>
          <CardDescription>Ordinate per numero di file che le importano.</CardDescription>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-80">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Libreria</TableHead>
                  <TableHead className="text-right">File</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {externals.map((row) => (
                  <TableRow key={row.name}>
                    <TableCell className="font-mono text-xs">{row.name}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.files}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </ScrollArea>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>File più usati</CardTitle>
          <CardDescription>File del progetto importati dal maggior numero di altri file.</CardDescription>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-80">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>File</TableHead>
                  <TableHead className="text-right">Usato da</TableHead>
                  <TableHead className="text-right">Importa</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {hubs.map((row) => (
                  <TableRow key={row.path} className="cursor-pointer" onClick={() => onOpenFile(row.path)}>
                    <TableCell className="max-w-72 truncate text-xs">{row.path}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.importedBy}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.imports}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  )
}
