import { statementText } from "./card-review"
import { type CardData, type Statement, sectionLabels } from "./statements"

function StatementList({ card, statements }: { card: CardData; statements: ReadonlyArray<Statement> }) {
  return (
    <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto rounded-md border p-2 text-sm">
      {statements.map((statement) => (
        <li key={statement.id}>
          <span className="text-muted-foreground">{sectionLabels[statement.section]}: </span>
          {statementText(card.content, statement.section, statement.index)}
        </li>
      ))}
    </ul>
  )
}

/** What an approval confirms and what it leaves open: shown in the approval dialog. */
export function ApprovalDetails({
  card,
  toCheck,
  wrong
}: {
  card: CardData
  toCheck: ReadonlyArray<Statement>
  wrong: ReadonlyArray<Statement>
}) {
  const current = card.verification !== null && card.verification.cardVersion === card.version
  const missing = current ? card.verification.missing.length : 0
  if (toCheck.length === 0 && wrong.length === 0 && missing === 0) return null
  return (
    <div className="flex flex-col gap-3 text-sm">
      {toCheck.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="font-medium">Da confermare</span>
          <StatementList card={card} statements={toCheck} />
        </div>
      )}
      {wrong.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="font-medium text-destructive">
            {wrong.length === 1 ? "Un'affermazione è segnata" : `${wrong.length} affermazioni sono segnate`} come
            sbagliata: approvando resta segnata così. Conviene correggerla prima.
          </span>
          <StatementList card={card} statements={wrong} />
        </div>
      )}
      {missing > 0 && (
        <span className="text-muted-foreground">
          La verifica segnala anche {missing === 1 ? "un elemento mancante" : `${missing} elementi mancanti`} nella
          scheda.
        </span>
      )}
    </div>
  )
}
