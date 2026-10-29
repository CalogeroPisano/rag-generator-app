import { type ChatSource } from "@code-to-rag/core"
import { Link } from "@tanstack/react-router"
import { FileTextIcon } from "lucide-react"
import { CardStatusBadge } from "@/components/status-badge"
import { cn } from "@/lib/utils"

/** Sources of an answer: the cited ones first; each opens the card's review page. */
export function ChatSources({
  idPrefix,
  projectId,
  sources,
  citations,
  highlighted
}: {
  /** Prefix of the element ids (`<prefix>-<n>`), used to scroll to a cited source. */
  idPrefix: string
  projectId: string
  sources: ReadonlyArray<ChatSource>
  citations: ReadonlyArray<number>
  highlighted: number | undefined
}) {
  if (sources.length === 0) return null
  const order = [...citations, ...sources.map((_, i) => i + 1).filter((n) => !citations.includes(n))]
  return (
    <ol className="flex flex-col gap-1.5">
      {order.map((n) => {
        const source = sources[n - 1]
        if (source === undefined) return null
        const cited = citations.includes(n)
        return (
          <li key={n} id={`${idPrefix}-${n}`}>
            <Link
              to="/projects/$projectId/cards/$featureId"
              params={{ projectId, featureId: source.featureId }}
              className={cn(
                "flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs hover:bg-muted",
                !cited && "opacity-60",
                highlighted === n && "ring-2 ring-primary"
              )}
            >
              <span className="flex size-5 shrink-0 items-center justify-center rounded bg-primary/10 font-semibold text-primary">
                {n}
              </span>
              <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium">{source.title}</span>
                <span className="text-muted-foreground"> · {source.featureName}</span>
              </span>
              {!cited && <span className="shrink-0 text-muted-foreground">non citata</span>}
              <CardStatusBadge status={source.status} />
            </Link>
          </li>
        )
      })}
    </ol>
  )
}
