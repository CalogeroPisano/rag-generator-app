import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { DatabaseIcon, RefreshCwIcon } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Spinner } from "@/components/ui/spinner"
import { getIndexStatus, getRagStatus, startIndexing } from "@/functions/rag.functions"
import { formatDateTime } from "@/lib/format"

/** Embedding index of the cards used by the chat: coverage, model, update and rebuild. */
export function IndexStatusCard({ snapshotId, projectId }: { snapshotId: string; projectId: string }) {
  const queryClient = useQueryClient()
  const rag = useQuery({ queryKey: ["rag-status"], queryFn: () => getRagStatus(), staleTime: 60_000 })
  const status = useQuery({
    queryKey: ["index-status", snapshotId],
    queryFn: () => getIndexStatus({ data: { snapshotId } }),
    refetchInterval: (query) =>
      query.state.data !== undefined &&
      query.state.data.model !== null &&
      query.state.data.indexedCards < query.state.data.indexableCards
        ? 5000
        : false
  })
  const index = useMutation({
    mutationFn: (rebuild: boolean) => startIndexing({ data: { snapshotId, rebuild } }),
    onSuccess: (_, rebuild) => {
      toast.info(rebuild ? "Ricostruzione dell'indice avviata" : "Aggiornamento dell'indice avviato")
      void queryClient.invalidateQueries({ queryKey: ["index-status", snapshotId] })
      void queryClient.invalidateQueries({ queryKey: ["project", projectId] })
    },
    onError: (error) => toast.error(error.message)
  })

  const data = status.data
  if (data === undefined || rag.data === undefined) return null
  const complete = data.indexedCards >= data.indexableCards
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <DatabaseIcon className="size-4" /> Indice per la chat
          {data.model === null ? (
            <Badge variant="secondary">Non configurato</Badge>
          ) : complete ? (
            <Badge variant="success">Aggiornato</Badge>
          ) : (
            <Badge variant="info">
              <Spinner data-icon="inline-start" />
              In aggiornamento
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          {data.model === null
            ? "Imposta EMBEDDING_MODEL sul server per indicizzare le schede e usare la chat."
            : `${data.indexedCards} di ${data.indexableCards} schede indicizzate (${data.approvedCards} approvate, le escluse non entrano) · ${data.chunks} frammenti · ${data.model}${data.indexedAt === null ? "" : ` · ${formatDateTime(data.indexedAt)}`}`}
        </CardDescription>
        {data.model !== null && (
          <CardAction className="flex gap-2">
            <Button size="sm" variant="outline" disabled={index.isPending} onClick={() => index.mutate(false)}>
              {index.isPending ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
              Aggiorna
            </Button>
            <Button size="sm" variant="ghost" disabled={index.isPending} onClick={() => index.mutate(true)}>
              Ricostruisci
            </Button>
          </CardAction>
        )}
      </CardHeader>
    </Card>
  )
}
