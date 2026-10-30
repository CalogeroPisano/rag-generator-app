import { SparklesIcon } from "lucide-react"
import type { getFileSummary } from "@/functions/understanding.functions"

type FileSummaryData = NonNullable<Awaited<ReturnType<typeof getFileSummary>>>

/** AI summary of a file and of its main declarations; selecting a declaration reveals its lines. */
export function FileSummary({
  summary,
  onSelectLines
}: {
  summary: FileSummaryData
  onSelectLines: (startLine: number, endLine: number) => void
}) {
  return (
    <div className="flex flex-col gap-4 p-4 text-sm">
      <div className="flex flex-col gap-1">
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <SparklesIcon className="size-3.5" />
          {/* "static-analysis": written by fixed rules, no model (files with no behaviour). */}
          {summary.model === "static-analysis"
            ? "Scritto dall'analisi statica: il file non contiene logica"
            : `Generato da ${summary.model}`}
        </span>
        <p className="leading-relaxed">{summary.summary}</p>
      </div>
      {summary.symbols.length > 0 && (
        <ul className="flex flex-col gap-1">
          {summary.symbols.map((symbol) => (
            <li key={`${symbol.qualifiedName}:${symbol.startLine}`}>
              <button
                type="button"
                onClick={() => onSelectLines(symbol.startLine, symbol.endLine)}
                className="flex w-full flex-col gap-0.5 rounded-sm px-2 py-1.5 text-left hover:bg-muted"
              >
                <span className="flex items-center gap-2">
                  <span className="font-mono text-xs">{symbol.qualifiedName}</span>
                  <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                    r. {symbol.startLine}–{symbol.endLine}
                  </span>
                </span>
                <span className="text-muted-foreground">{symbol.summary}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
