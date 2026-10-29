import { Badge } from "@/components/ui/badge"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { cn } from "@/lib/utils"
import { type SymbolData, symbolKindLabels } from "./labels"

/** Nesting depth from the container chain (qualified names). */
const depths = (symbols: ReadonlyArray<SymbolData>): Map<SymbolData, number> => {
  const byName = new Map(symbols.map((symbol) => [symbol.qualifiedName, symbol]))
  const result = new Map<SymbolData, number>()
  const depthOf = (symbol: SymbolData, guard = 0): number => {
    const known = result.get(symbol)
    if (known !== undefined) return known
    const parent = symbol.container === null ? undefined : byName.get(symbol.container)
    const depth =
      symbol.container === null ? 0 : parent === undefined || guard > 20 ? 1 : depthOf(parent, guard + 1) + 1
    result.set(symbol, depth)
    return depth
  }
  for (const symbol of symbols) depthOf(symbol)
  return result
}

/** Declarations of a file, nested by container; selecting one reveals its lines in the code. */
export function FileOutline({
  symbols,
  onSelect
}: {
  symbols: ReadonlyArray<SymbolData>
  onSelect: (symbol: SymbolData) => void
}) {
  if (symbols.length === 0) {
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyTitle>Nessuna dichiarazione</EmptyTitle>
          <EmptyDescription>Il file non contiene classi, funzioni o costanti riconosciute.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  const depth = depths(symbols)
  return (
    <ul className="flex flex-col p-1 text-sm">
      {symbols.map((symbol) => (
        <li key={`${symbol.qualifiedName}:${symbol.startLine}`}>
          <button
            type="button"
            onClick={() => onSelect(symbol)}
            style={{ paddingLeft: `${(depth.get(symbol) ?? 0) * 16 + 8}px` }}
            className="flex w-full items-center gap-2 rounded-sm py-1 pr-2 text-left hover:bg-muted"
            title={symbol.doc ?? symbol.signature}
          >
            <Badge variant="outline" className="w-24 shrink-0 justify-start text-muted-foreground">
              {symbolKindLabels[symbol.kind]}
            </Badge>
            <span className={cn("min-w-0 truncate font-mono text-xs", !symbol.exported && "text-muted-foreground")}>
              {symbol.signature}
            </span>
            <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
              {symbol.startLine === symbol.endLine
                ? `r. ${symbol.startLine}`
                : `r. ${symbol.startLine}–${symbol.endLine}`}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}
