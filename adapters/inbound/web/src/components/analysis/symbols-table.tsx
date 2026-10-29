import { type SymbolKind } from "@code-to-rag/core"
import { useInfiniteQuery } from "@tanstack/react-query"
import { SearchIcon } from "lucide-react"
import { useDeferredValue, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { listSymbols } from "@/functions/analysis.functions"
import { cn } from "@/lib/utils"
import { symbolKindLabels, symbolKinds } from "./labels"

const ALL = "all"

/** Searchable list of every declaration of the snapshot. */
export function SymbolsTable({
  snapshotId,
  onOpen
}: {
  snapshotId: string
  onOpen: (path: string, startLine: number, endLine: number) => void
}) {
  const [search, setSearch] = useState("")
  const [kind, setKind] = useState<SymbolKind | typeof ALL>(ALL)
  const [exportedOnly, setExportedOnly] = useState(false)
  // Typing stays responsive; the query follows the deferred value.
  const deferredSearch = useDeferredValue(search)

  const symbols = useInfiniteQuery({
    queryKey: ["symbols", snapshotId, deferredSearch, kind, exportedOnly],
    queryFn: ({ pageParam }) =>
      listSymbols({
        data: {
          snapshotId,
          offset: pageParam,
          exportedOnly,
          ...(deferredSearch.trim() === "" ? {} : { search: deferredSearch.trim() }),
          ...(kind === ALL ? {} : { kind })
        }
      }),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((sum, page) => sum + page.items.length, 0)
      return loaded < last.total ? loaded : undefined
    }
  })

  const rows = symbols.data?.pages.flatMap((page) => page.items) ?? []
  const total = symbols.data?.pages[0]?.total

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-64 flex-1">
          <SearchIcon className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Cerca per nome (es. Order, create)…"
            className="pl-8"
            aria-label="Cerca simboli"
          />
        </div>
        <Select value={kind} onValueChange={(value) => setKind(value as SymbolKind | typeof ALL)}>
          <SelectTrigger className="w-44" aria-label="Tipo di simbolo">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Tutti i tipi</SelectItem>
            {symbolKinds.map((value) => (
              <SelectItem key={value} value={value}>
                {symbolKindLabels[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2">
          <Checkbox
            id="exported-only"
            checked={exportedOnly}
            onCheckedChange={(checked) => setExportedOnly(checked === true)}
          />
          <Label htmlFor="exported-only">Solo pubblici</Label>
        </div>
        {total !== undefined && (
          <span className="text-sm text-muted-foreground tabular-nums">{total.toLocaleString("it-IT")} risultati</span>
        )}
      </div>
      <Card className="py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nome</TableHead>
              <TableHead>Tipo</TableHead>
              <TableHead>File</TableHead>
              <TableHead className="text-right">Righe</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((symbol) => (
              <TableRow
                key={`${symbol.path}:${symbol.qualifiedName}:${symbol.startLine}`}
                className="cursor-pointer"
                onClick={() => onOpen(symbol.path, symbol.startLine, symbol.endLine)}
              >
                <TableCell className="max-w-96">
                  <div className={cn("truncate font-medium", !symbol.exported && "text-muted-foreground")}>
                    {symbol.qualifiedName}
                  </div>
                  <div className="truncate font-mono text-xs text-muted-foreground">{symbol.signature}</div>
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{symbolKindLabels[symbol.kind]}</Badge>
                </TableCell>
                <TableCell className="max-w-80 truncate text-xs text-muted-foreground">{symbol.path}</TableCell>
                <TableCell className="text-right text-xs text-muted-foreground tabular-nums">
                  {symbol.startLine}–{symbol.endLine}
                </TableCell>
              </TableRow>
            ))}
            {rows.length === 0 && !symbols.isPending && (
              <TableRow>
                <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                  Nessun simbolo trovato.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
      {(symbols.isPending || symbols.hasNextPage) && (
        <Button
          variant="outline"
          className="self-center"
          disabled={symbols.isFetching}
          onClick={() => void symbols.fetchNextPage()}
        >
          {symbols.isFetching && <Spinner data-icon="inline-start" />}
          {symbols.isPending ? "Caricamento…" : "Carica altri"}
        </Button>
      )}
    </div>
  )
}
