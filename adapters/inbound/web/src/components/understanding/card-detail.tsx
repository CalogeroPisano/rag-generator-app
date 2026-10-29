import { useQuery } from "@tanstack/react-query"
import { FileCodeIcon, TriangleAlertIcon } from "lucide-react"
import type { ReactNode } from "react"
import { CardStatusBadge } from "@/components/status-badge"
import { Badge } from "@/components/ui/badge"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { getCard } from "@/functions/understanding.functions"
import { formatDateTime } from "@/lib/format"

type CardData = Awaited<ReturnType<typeof getCard>>
type Reference = CardData["content"]["behavior"][number]["references"][number]

export type OpenReference = (path: string, startLine: number, endLine: number) => void

const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1)

function References({ references, onOpen }: { references: ReadonlyArray<Reference>; onOpen: OpenReference }) {
  if (references.length === 0) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="warning" className="cursor-default">
            <TriangleAlertIcon data-icon="inline-start" />
            Senza riferimenti
          </Badge>
        </TooltipTrigger>
        <TooltipContent>Nessuna riga di codice valida supporta questa affermazione: va verificata.</TooltipContent>
      </Tooltip>
    )
  }
  return (
    <>
      {references.map((reference) => (
        <Tooltip key={`${reference.path}:${reference.startLine}-${reference.endLine}`}>
          <TooltipTrigger asChild>
            <button type="button" onClick={() => onOpen(reference.path, reference.startLine, reference.endLine)}>
              <Badge variant="outline" className="cursor-pointer font-mono hover:bg-muted">
                <FileCodeIcon data-icon="inline-start" />
                {fileName(reference.path)}:{reference.startLine}
                {reference.endLine !== reference.startLine && `–${reference.endLine}`}
              </Badge>
            </button>
          </TooltipTrigger>
          <TooltipContent>{reference.path}</TooltipContent>
        </Tooltip>
      ))}
    </>
  )
}

function Statement({
  children,
  references,
  onOpen
}: {
  children: ReactNode
  references: ReadonlyArray<Reference>
  onOpen: OpenReference
}) {
  return (
    <li className="flex flex-col gap-1.5">
      <div className="leading-relaxed">{children}</div>
      <div className="flex flex-wrap gap-1">
        <References references={references} onOpen={onOpen} />
      </div>
    </li>
  )
}

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  if (count === 0) return null
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-medium">{title}</h3>
      <ul className="flex flex-col gap-4 text-sm">{children}</ul>
    </section>
  )
}

/** A functional card with its sections; every statement links to the source lines it comes from. */
export function CardDetail({
  snapshotId,
  cardId,
  onOpenReference
}: {
  snapshotId: string
  cardId: string
  onOpenReference: OpenReference
}) {
  const card = useQuery({
    queryKey: ["card", snapshotId, cardId],
    queryFn: () => getCard({ data: { snapshotId, cardId } }),
    staleTime: Infinity
  })
  if (card.data === undefined) return <Skeleton className="h-96 w-full" />
  const { content } = card.data
  const open = onOpenReference

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{content.title}</CardTitle>
        <CardDescription>
          {card.data.feature.name} · {card.data.model} · {formatDateTime(card.data.createdAt)}
        </CardDescription>
        <CardAction>
          <CardStatusBadge status={card.data.status} />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <p className="leading-relaxed">{content.summary}</p>
        {card.data.unreferencedStatements > 0 && (
          <p className="flex items-center gap-2 text-sm text-warning">
            <TriangleAlertIcon className="size-4" />
            {card.data.unreferencedStatements === 1
              ? "1 affermazione non è collegata al codice."
              : `${card.data.unreferencedStatements} affermazioni non sono collegate al codice.`}
          </p>
        )}
        <Separator />
        <Section title="Cosa fa" count={content.behavior.length}>
          {content.behavior.map((item, i) => (
            <Statement key={i} references={item.references} onOpen={open}>
              {item.text}
            </Statement>
          ))}
        </Section>
        <Section title="Configurazione" count={content.configuration.length}>
          {content.configuration.map((item, i) => (
            <Statement key={i} references={item.references} onOpen={open}>
              {item.text}
            </Statement>
          ))}
        </Section>
        <Section title="Parametri" count={content.parameters.length}>
          {content.parameters.map((item, i) => (
            <Statement key={i} references={item.references} onOpen={open}>
              <span className="font-mono text-xs">{item.name}</span>
              {item.type !== null && <span className="text-muted-foreground"> ({item.type})</span>}
              {item.required === true && (
                <Badge variant="secondary" className="ml-2">
                  obbligatorio
                </Badge>
              )}
              <span> — {item.description}</span>
              {item.defaultValue !== null && (
                <span className="text-muted-foreground"> Predefinito: {item.defaultValue}.</span>
              )}
            </Statement>
          ))}
        </Section>
        <Section title="Limiti" count={content.limits.length}>
          {content.limits.map((item, i) => (
            <Statement key={i} references={item.references} onOpen={open}>
              {item.text}
            </Statement>
          ))}
        </Section>
        <Section title="Regole di validazione" count={content.validationRules.length}>
          {content.validationRules.map((item, i) => (
            <Statement key={i} references={item.references} onOpen={open}>
              {item.text}
            </Statement>
          ))}
        </Section>
        <Section title="Errori" count={content.errors.length}>
          {content.errors.map((item, i) => (
            <Statement key={i} references={item.references} onOpen={open}>
              {item.condition}
              {item.message !== null && (
                <span className="text-muted-foreground">
                  {" "}
                  — messaggio: <q>{item.message}</q>
                </span>
              )}
            </Statement>
          ))}
        </Section>
      </CardContent>
    </Card>
  )
}
