import { useQuery } from "@tanstack/react-query"
import { FileIcon, SparklesIcon } from "lucide-react"
import { useState } from "react"
import { CardStatusBadge } from "@/components/status-badge"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { getFeatureMap } from "@/functions/understanding.functions"
import { cn } from "@/lib/utils"
import { CardDetail, type OpenReference } from "./card-detail"
import { ModelCallStats } from "./model-call-stats"

/** Feature map of a snapshot: features on the left, the card of the selected one on the right. */
export function FeaturesPanel({
  snapshotId,
  onOpenReference,
  onOpenFile
}: {
  snapshotId: string
  onOpenReference: OpenReference
  onOpenFile: (path: string) => void
}) {
  const map = useQuery({
    queryKey: ["feature-map", snapshotId],
    queryFn: () => getFeatureMap({ data: { snapshotId } }),
    staleTime: Infinity
  })
  const [selectedId, setSelectedId] = useState<string | undefined>()

  if (map.data === undefined) return <Skeleton className="h-96 w-full" />
  const { features, projectSummary } = map.data
  if (features.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle>Nessuna funzionalità</EmptyTitle>
          <EmptyDescription>
            La comprensione con IA non ha ancora prodotto la mappa delle funzionalità.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  const selected = features.find((feature) => feature.id === selectedId) ?? features[0]!

  return (
    <div className="flex flex-col gap-4">
      {projectSummary !== null && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <SparklesIcon className="size-4" /> Panoramica dell'applicativo
            </CardTitle>
            <CardDescription className="leading-relaxed text-foreground">{projectSummary}</CardDescription>
          </CardHeader>
        </Card>
      )}
      <div className="grid gap-4 lg:grid-cols-[minmax(260px,340px)_1fr]">
        <Card className="py-0">
          <ScrollArea className="max-h-[75vh]">
            <ul className="flex flex-col p-2">
              {features.map((feature) => (
                <li key={feature.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(feature.id)}
                    className={cn(
                      "flex w-full flex-col gap-1 rounded-md px-3 py-2 text-left hover:bg-muted",
                      feature.id === selected.id && "bg-muted"
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{feature.name}</span>
                      {feature.card === null ? (
                        <Badge variant="secondary">Senza scheda</Badge>
                      ) : (
                        <CardStatusBadge status={feature.card.status} />
                      )}
                    </span>
                    <span className="line-clamp-2 text-xs text-muted-foreground">{feature.description}</span>
                  </button>
                </li>
              ))}
            </ul>
          </ScrollArea>
        </Card>
        <div className="flex min-w-0 flex-col gap-4">
          {selected.card === null ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyTitle>Scheda non disponibile</EmptyTitle>
                <EmptyDescription>
                  Il modello non ha prodotto una scheda valida per questa funzionalità: rilancia la generazione.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <CardDetail snapshotId={snapshotId} cardId={selected.card.id} onOpenReference={onOpenReference} />
          )}
          <Card>
            <CardHeader>
              <CardTitle>File coinvolti</CardTitle>
              <CardDescription>Letti insieme per generare la scheda.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              {selected.files.map((path) => (
                <button key={path} type="button" onClick={() => onOpenFile(path)}>
                  <Badge variant="outline" className="cursor-pointer font-mono hover:bg-muted">
                    <FileIcon data-icon="inline-start" />
                    {path}
                  </Badge>
                </button>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
      <ModelCallStats snapshotId={snapshotId} />
    </div>
  )
}
