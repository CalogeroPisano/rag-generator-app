import { CircleCheckIcon, CircleHelpIcon, CircleXIcon, FileCodeIcon, TriangleAlertIcon } from "lucide-react"
import type { ReactNode } from "react"
import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { formatDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import {
  type CardData,
  type Content,
  formatReference,
  type Reference,
  SECTIONS,
  type SectionName,
  sectionLabels
} from "./statements"

type Verdict = NonNullable<CardData["verification"]>["statements"][number]

const verdictStyle: Record<
  Verdict["verdict"],
  { label: string; variant: "success" | "warning" | "destructive"; icon: ReactNode }
> = {
  supported: { label: "Confermata", variant: "success", icon: <CircleCheckIcon data-icon="inline-start" /> },
  partial: { label: "Conferma parziale", variant: "warning", icon: <CircleHelpIcon data-icon="inline-start" /> },
  unsupported: { label: "Non confermata", variant: "destructive", icon: <CircleXIcon data-icon="inline-start" /> }
}

function VerdictBadge({ verdict }: { verdict: Verdict | undefined }) {
  if (verdict === undefined) return null
  const style = verdictStyle[verdict.verdict]
  const badge = (
    <Badge variant={style.variant}>
      {style.icon}
      {style.label}
    </Badge>
  )
  // Decision model: the probability that the code supports the statement; language model: its note.
  const detail =
    verdict.probability === undefined
      ? verdict.note
      : `Probabilità che il codice confermi l'affermazione: ${Math.round(verdict.probability * 100)}%`
  if (detail === "") return badge
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>{badge}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm">{detail}</TooltipContent>
    </Tooltip>
  )
}

function ReferenceChips({
  references,
  onOpen
}: {
  references: ReadonlyArray<Reference>
  onOpen: (reference: Reference) => void
}) {
  if (references.length === 0) {
    return (
      <Badge variant="warning">
        <TriangleAlertIcon data-icon="inline-start" />
        Senza riferimenti
      </Badge>
    )
  }
  return (
    <>
      {references.map((reference) => (
        <button
          key={`${reference.path}:${reference.startLine}-${reference.endLine}`}
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            onOpen(reference)
          }}
          title={reference.path}
        >
          <Badge variant="outline" className="cursor-pointer font-mono hover:bg-muted">
            <FileCodeIcon data-icon="inline-start" />
            {formatReference(reference)}
          </Badge>
        </button>
      ))}
    </>
  )
}

/** Text of a statement as the reviewer reads it. */
const statementText = (content: Content, section: SectionName, index: number): ReactNode => {
  switch (section) {
    case "parameters": {
      const item = content.parameters[index]!
      return (
        <>
          <span className="font-mono text-xs">{item.name}</span>
          {item.type !== null && <span className="text-muted-foreground"> ({item.type})</span>}
          {item.required === true && <span className="text-muted-foreground"> · obbligatorio</span>}
          <span> — {item.description}</span>
          {item.defaultValue !== null && (
            <span className="text-muted-foreground"> Predefinito: {item.defaultValue}.</span>
          )}
        </>
      )
    }
    case "errors": {
      const item = content.errors[index]!
      return (
        <>
          {item.condition}
          {item.message !== null && (
            <span className="text-muted-foreground">
              {" "}
              — messaggio: <q>{item.message}</q>
            </span>
          )}
        </>
      )
    }
    default:
      return content[section][index]!.text
  }
}

/**
 * Read-only card for the review: every statement shows the verdict of the
 * verification; selecting it (or one of its references) shows its lines.
 */
export function CardReview({
  card,
  selected,
  onSelect
}: {
  card: CardData
  selected: string | undefined
  onSelect: (statementId: string, reference: Reference | undefined) => void
}) {
  const { content, verification } = card
  const current = verification !== null && verification.cardVersion === card.version
  const verdicts = new Map(current ? verification.statements.map((s) => [s.id, s]) : [])

  return (
    <div className="flex flex-col gap-6 text-sm">
      <p className="leading-relaxed">{content.summary}</p>

      {verification === null ? (
        <p className="text-muted-foreground">Scheda non ancora verificata.</p>
      ) : (
        <div
          className={cn(
            "flex flex-col gap-1 rounded-lg border p-3",
            current && verification.issues > 0 && "border-warning/50 bg-warning/5"
          )}
        >
          <span className="font-medium">
            {!current
              ? "Verifica non aggiornata: la scheda è cambiata dopo l'ultima verifica."
              : verification.issues === 0
                ? "Verifica superata: ogni affermazione è confermata dal codice."
                : `La verifica ha trovato ${verification.issues} ${verification.issues === 1 ? "punto da controllare" : "punti da controllare"}.`}
          </span>
          <span className="text-xs text-muted-foreground">
            Versione {verification.cardVersion} · {verification.model} · {formatDateTime(verification.verifiedAt)}
          </span>
        </div>
      )}

      {SECTIONS.map((section) => {
        const items = content[section]
        if (items.length === 0) return null
        return (
          <section key={section} className="flex flex-col gap-2">
            <h3 className="font-medium">{sectionLabels[section]}</h3>
            <ul className="flex flex-col gap-1">
              {items.map((item, index) => {
                const id = `${section}.${index}`
                return (
                  <li key={id}>
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => onSelect(id, item.references[0])}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") onSelect(id, item.references[0])
                      }}
                      className={cn(
                        "flex cursor-pointer flex-col gap-1.5 rounded-md border border-transparent px-3 py-2 hover:bg-muted",
                        selected === id && "border-info/50 bg-info/5"
                      )}
                    >
                      <div className="leading-relaxed">{statementText(content, section, index)}</div>
                      <div className="flex flex-wrap items-center gap-1">
                        <VerdictBadge verdict={verdicts.get(id)} />
                        <ReferenceChips references={item.references} onOpen={(reference) => onSelect(id, reference)} />
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          </section>
        )
      })}

      {current && verification.missingSuspected && (
        <div className="flex items-start gap-2 rounded-md border border-dashed px-3 py-2">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" />
          <span>
            Il codice potrebbe contenere regole, limiti, errori o impostazioni che la scheda non descrive
            {verification.missingProbability === null
              ? ""
              : ` (probabilità ${Math.round(verification.missingProbability * 100)}%)`}
            : confrontala con il codice della funzionalità.
          </span>
        </div>
      )}

      {current && verification.missing.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="flex items-center gap-2 font-medium">
            <TriangleAlertIcon className="size-4 text-warning" /> Mancanti secondo la verifica
          </h3>
          <ul className="flex flex-col gap-1">
            {verification.missing.map((item, i) => {
              const id = `missing.${i}`
              return (
                <li key={id}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => onSelect(id, item.references[0])}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") onSelect(id, item.references[0])
                    }}
                    className={cn(
                      "flex cursor-pointer flex-col gap-1.5 rounded-md border border-dashed px-3 py-2 hover:bg-muted",
                      selected === id && "border-info/50 bg-info/5"
                    )}
                  >
                    <span>
                      <span className="text-muted-foreground">{sectionLabels[item.section]}: </span>
                      {item.text}
                    </span>
                    <div className="flex flex-wrap gap-1">
                      <ReferenceChips references={item.references} onOpen={(reference) => onSelect(id, reference)} />
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      )}
    </div>
  )
}
