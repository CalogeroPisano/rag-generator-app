import {
  CircleCheckIcon,
  CircleHelpIcon,
  CircleXIcon,
  FileCodeIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  TriangleAlertIcon,
  UserCheckIcon,
  UserXIcon
} from "lucide-react"
import type { ReactNode } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
  sectionLabels,
  type StatementReviewVerdict
} from "./statements"

type Verdict = NonNullable<CardData["verification"]>["statements"][number]
type Review = CardData["statementReviews"][number]

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

/** The reviewer's decision: it replaces the automatic verdict, which stays in the tooltip. */
function ReviewBadge({ review, verdict }: { review: Review; verdict: Verdict | undefined }) {
  const badge =
    review.verdict === "confirmed" ? (
      <Badge variant="success">
        <UserCheckIcon data-icon="inline-start" />
        Confermata da {review.reviewer}
      </Badge>
    ) : (
      <Badge variant="destructive">
        <UserXIcon data-icon="inline-start" />
        Sbagliata secondo {review.reviewer}
      </Badge>
    )
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>{badge}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm">
        {formatDateTime(new Date(review.reviewedAt))}
        {verdict !== undefined && ` · verifica automatica: ${verdictStyle[verdict.verdict].label.toLowerCase()}`}
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * Status of a statement of the current card version: the reviewer's decision if any, otherwise the automatic
 * verdict (when the verification is current).
 */
export function StatementStatus({ card, id }: { card: CardData; id: string }) {
  const current = card.verification !== null && card.verification.cardVersion === card.version
  const verdict = current ? card.verification.statements.find((s) => s.id === id) : undefined
  const review = card.statementReviews.find((r) => r.id === id)
  return review === undefined ? <VerdictBadge verdict={verdict} /> : <ReviewBadge review={review} verdict={verdict} />
}

/** Buttons of the reviewer's decision on a statement; pressing the active one removes it. */
function ReviewButtons({
  value,
  disabled,
  onChange
}: {
  value: StatementReviewVerdict | undefined
  disabled: boolean
  onChange: (verdict: StatementReviewVerdict | null) => void
}) {
  const button = (verdict: StatementReviewVerdict, label: string, icon: ReactNode) => (
    <Button
      type="button"
      variant={value === verdict ? (verdict === "confirmed" ? "default" : "destructive") : "ghost"}
      size="icon"
      className="size-7"
      disabled={disabled}
      title={value === verdict ? "Annulla la tua decisione" : label}
      aria-label={value === verdict ? "Annulla la tua decisione" : label}
      aria-pressed={value === verdict}
      onClick={(event) => {
        event.stopPropagation()
        onChange(value === verdict ? null : verdict)
      }}
    >
      {icon}
    </Button>
  )
  return (
    <span className="ml-auto flex gap-1">
      {button("confirmed", "Confermo l'affermazione", <ThumbsUpIcon />)}
      {button("wrong", "L'affermazione è sbagliata", <ThumbsDownIcon />)}
    </span>
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
export const statementText = (content: Content, section: SectionName, index: number): ReactNode => {
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
  onSelect,
  onReview,
  reviewDisabled
}: {
  card: CardData
  selected: string | undefined
  onSelect: (statementId: string, reference: Reference | undefined) => void
  /** The reviewer's decision on a statement (`null` removes it). */
  onReview: (statementId: string, verdict: StatementReviewVerdict | null) => void
  reviewDisabled: boolean
}) {
  const { content, verification } = card
  const current = verification !== null && verification.cardVersion === card.version
  const reviews = new Map(card.statementReviews.map((review) => [review.id, review]))

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
                        <StatementStatus card={card} id={id} />
                        <ReferenceChips references={item.references} onOpen={(reference) => onSelect(id, reference)} />
                        <ReviewButtons
                          value={reviews.get(id)?.verdict}
                          disabled={reviewDisabled}
                          onChange={(verdict) => onReview(id, verdict)}
                        />
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          </section>
        )
      })}

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
