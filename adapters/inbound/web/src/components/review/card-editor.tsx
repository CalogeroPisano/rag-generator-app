import { PlusIcon, Trash2Icon, XIcon } from "lucide-react"
import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Textarea } from "@/components/ui/textarea"
import { StatementStatus } from "./card-review"
import {
  type CardData,
  type Content,
  fileName,
  formatReference,
  type Reference,
  type SectionName,
  sectionLabels
} from "./statements"

/** Item fields as compared with the original: trimmed texts, blank optional values as null. */
const normalize = (item: object): unknown =>
  Object.fromEntries(
    Object.entries(item).map(([key, value]) => [
      key,
      typeof value === "string" ? (value.trim() === "" && key !== "text" ? null : value.trim()) : value
    ])
  )

type Mutable<T> = { -readonly [K in keyof T]: T[K] extends ReadonlyArray<infer U> ? Array<Mutable<U>> : T[K] }
type Ref = Mutable<Reference>
/** `origin`: id (`section.index`) of the statement of the current version an item comes from; absent when new. */
interface StatementDraft {
  text: string
  references: Array<Ref>
  origin?: string
}
interface ParameterDraft {
  name: string
  description: string
  type: string | null
  required: boolean | null
  defaultValue: string | null
  references: Array<Ref>
  origin?: string
}
interface ErrorDraft {
  condition: string
  message: string | null
  references: Array<Ref>
  origin?: string
}
export interface CardDraft {
  title: string
  summary: string
  behavior: Array<StatementDraft>
  configuration: Array<StatementDraft>
  parameters: Array<ParameterDraft>
  limits: Array<StatementDraft>
  validationRules: Array<StatementDraft>
  errors: Array<ErrorDraft>
}

const SECTION_NAMES = ["behavior", "configuration", "parameters", "limits", "validationRules", "errors"] as const

/** Every item remembers the statement it comes from, so that its status stays visible while items move. */
export const toDraft = (content: Content): CardDraft => {
  const draft = structuredClone(content) as unknown as CardDraft
  for (const section of SECTION_NAMES) {
    draft[section].forEach((item, index) => (item.origin = `${section}.${index}`))
  }
  return draft
}

const withoutOrigin = <T extends { origin?: string }>({ origin: _origin, ...item }: T): Omit<T, "origin"> => item

const blank = (text: string) => (text.trim() === "" ? null : text.trim())

/** Drops empty items and trims texts, so that the saved card matches what the reviewer sees. */
export const fromDraft = (draft: CardDraft): Content => ({
  title: draft.title.trim(),
  summary: draft.summary.trim(),
  behavior: draft.behavior
    .filter((s) => s.text.trim() !== "")
    .map((s) => ({ ...withoutOrigin(s), text: s.text.trim() })),
  configuration: draft.configuration
    .filter((s) => s.text.trim() !== "")
    .map((s) => ({ ...withoutOrigin(s), text: s.text.trim() })),
  parameters: draft.parameters
    .filter((p) => p.name.trim() !== "")
    .map((p) => ({
      ...withoutOrigin(p),
      name: p.name.trim(),
      description: p.description.trim(),
      type: blank(p.type ?? ""),
      defaultValue: blank(p.defaultValue ?? "")
    })),
  limits: draft.limits.filter((s) => s.text.trim() !== "").map((s) => ({ ...withoutOrigin(s), text: s.text.trim() })),
  validationRules: draft.validationRules
    .filter((s) => s.text.trim() !== "")
    .map((s) => ({ ...withoutOrigin(s), text: s.text.trim() })),
  errors: draft.errors
    .filter((e) => e.condition.trim() !== "")
    .map((e) => ({ ...withoutOrigin(e), condition: e.condition.trim(), message: blank(e.message ?? "") }))
})

function ReferencesEditor({
  references,
  files,
  defaultPath,
  onChange
}: {
  references: Array<Ref>
  files: ReadonlyArray<string>
  defaultPath: string | undefined
  onChange: (references: Array<Ref>) => void
}) {
  const [path, setPath] = useState<string | undefined>(defaultPath)
  const [start, setStart] = useState("")
  const [end, setEnd] = useState("")
  const chosen = path ?? defaultPath ?? files[0]
  const add = () => {
    const startLine = Number.parseInt(start, 10)
    const endLine = end === "" ? startLine : Number.parseInt(end, 10)
    if (chosen === undefined || !Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1) return
    onChange([
      ...references,
      { path: chosen, startLine: Math.min(startLine, endLine), endLine: Math.max(startLine, endLine) }
    ])
    setStart("")
    setEnd("")
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1">
        {references.map((reference, i) => (
          <Badge
            key={`${reference.path}:${reference.startLine}-${reference.endLine}:${i}`}
            variant="outline"
            className="font-mono"
          >
            {formatReference(reference)}
            <button
              type="button"
              aria-label="Rimuovi riferimento"
              onClick={() => onChange(references.filter((_, j) => j !== i))}
            >
              <XIcon className="size-3" />
            </button>
          </Badge>
        ))}
        {references.length === 0 && <span className="text-xs text-muted-foreground">Nessun riferimento</span>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={chosen ?? ""} onValueChange={setPath}>
          <SelectTrigger size="sm" className="w-48 font-mono text-xs">
            <SelectValue placeholder="File" />
          </SelectTrigger>
          <SelectContent>
            {files.map((file) => (
              <SelectItem key={file} value={file} className="font-mono text-xs">
                {fileName(file)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          aria-label="Riga iniziale"
          placeholder="da"
          inputMode="numeric"
          className="h-8 w-16"
          value={start}
          onChange={(event) => setStart(event.target.value)}
        />
        <Input
          aria-label="Riga finale"
          placeholder="a"
          inputMode="numeric"
          className="h-8 w-16"
          value={end}
          onChange={(event) => setEnd(event.target.value)}
        />
        <Button type="button" size="sm" variant="outline" onClick={add}>
          <PlusIcon data-icon="inline-start" />
          Riferimento
        </Button>
      </div>
    </div>
  )
}

function ItemShell({
  children,
  status,
  onRemove
}: {
  children: React.ReactNode
  /** Status of the statement the item comes from (verification, reviewer decision, changes). */
  status: React.ReactNode
  onRemove: () => void
}) {
  return (
    <div className="flex gap-2 rounded-md border p-3">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-1">{status}</div>
        {children}
      </div>
      <Button type="button" size="icon" variant="ghost" aria-label="Elimina voce" onClick={onRemove}>
        <Trash2Icon />
      </Button>
    </div>
  )
}

const STATEMENT_SECTIONS = ["behavior", "configuration", "limits", "validationRules"] as const

/** Structured editing of a card: every section, item and reference. */
export function CardEditor({
  draft,
  onChange,
  files,
  currentPath,
  card
}: {
  draft: CardDraft
  onChange: (draft: CardDraft) => void
  files: ReadonlyArray<string>
  /** File open in the code pane: new references default to it. */
  currentPath: string | undefined
  /** The card being edited (current version): status of the statements the items come from. */
  card: CardData
}) {
  const status = (section: SectionName, item: { origin?: string }) => {
    if (item.origin === undefined) return <Badge variant="info">Nuova</Badge>
    const [originSection, index] = item.origin.split(".") as [SectionName, string]
    const original = card.content[originSection][Number(index)]
    const { origin: _origin, ...edited } = item as Record<string, unknown>
    const changed = original === undefined || JSON.stringify(normalize(original)) !== JSON.stringify(normalize(edited))
    return (
      <>
        <StatementStatus card={card} id={item.origin} />
        {originSection !== section && <Badge variant="outline">Da: {sectionLabels[originSection]}</Badge>}
        {changed && <Badge variant="warning">Modificata: lo stato si azzera al salvataggio</Badge>}
      </>
    )
  }
  const update = (patch: Partial<CardDraft>) => onChange({ ...draft, ...patch })
  const refs = (references: Array<Ref>, set: (references: Array<Ref>) => void) => (
    <ReferencesEditor references={references} files={files} defaultPath={currentPath} onChange={set} />
  )

  return (
    <div className="flex flex-col gap-6 text-sm">
      <div className="flex flex-col gap-2">
        <Label htmlFor="card-title">Titolo</Label>
        <Input id="card-title" value={draft.title} onChange={(event) => update({ title: event.target.value })} />
        <Label htmlFor="card-summary">Riepilogo</Label>
        <Textarea
          id="card-summary"
          value={draft.summary}
          onChange={(event) => update({ summary: event.target.value })}
        />
      </div>

      {STATEMENT_SECTIONS.map((section) => (
        <section key={section} className="flex flex-col gap-2">
          <Separator />
          <h3 className="font-medium">{sectionLabels[section]}</h3>
          {draft[section].map((item, i) => {
            const set = (next: StatementDraft) =>
              update({ [section]: draft[section].map((s, j) => (j === i ? next : s)) })
            return (
              <ItemShell
                key={i}
                status={status(section, item)}
                onRemove={() => update({ [section]: draft[section].filter((_, j) => j !== i) })}
              >
                <Textarea value={item.text} onChange={(event) => set({ ...item, text: event.target.value })} />
                {refs(item.references, (references) => set({ ...item, references }))}
              </ItemShell>
            )
          })}
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="self-start"
            onClick={() => update({ [section]: [...draft[section], { text: "", references: [] }] })}
          >
            <PlusIcon data-icon="inline-start" />
            Aggiungi
          </Button>
        </section>
      ))}

      <section className="flex flex-col gap-2">
        <Separator />
        <h3 className="font-medium">{sectionLabels.parameters}</h3>
        {draft.parameters.map((item, i) => {
          const set = (next: ParameterDraft) =>
            update({ parameters: draft.parameters.map((p, j) => (j === i ? next : p)) })
          return (
            <ItemShell
              key={i}
              status={status("parameters", item)}
              onRemove={() => update({ parameters: draft.parameters.filter((_, j) => j !== i) })}
            >
              <div className="grid gap-2 sm:grid-cols-2">
                <Input
                  placeholder="Nome"
                  value={item.name}
                  onChange={(event) => set({ ...item, name: event.target.value })}
                />
                <Input
                  placeholder="Tipo o valori ammessi"
                  value={item.type ?? ""}
                  onChange={(event) => set({ ...item, type: event.target.value })}
                />
                <Input
                  placeholder="Valore predefinito"
                  value={item.defaultValue ?? ""}
                  onChange={(event) => set({ ...item, defaultValue: event.target.value })}
                />
                <Select
                  value={item.required === null ? "unknown" : item.required ? "yes" : "no"}
                  onValueChange={(value) => set({ ...item, required: value === "unknown" ? null : value === "yes" })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="yes">Obbligatorio</SelectItem>
                    <SelectItem value="no">Facoltativo</SelectItem>
                    <SelectItem value="unknown">Non specificato</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Textarea
                placeholder="Descrizione"
                value={item.description}
                onChange={(event) => set({ ...item, description: event.target.value })}
              />
              {refs(item.references, (references) => set({ ...item, references }))}
            </ItemShell>
          )
        })}
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="self-start"
          onClick={() =>
            update({
              parameters: [
                ...draft.parameters,
                { name: "", description: "", type: null, required: null, defaultValue: null, references: [] }
              ]
            })
          }
        >
          <PlusIcon data-icon="inline-start" />
          Aggiungi
        </Button>
      </section>

      <section className="flex flex-col gap-2">
        <Separator />
        <h3 className="font-medium">{sectionLabels.errors}</h3>
        {draft.errors.map((item, i) => {
          const set = (next: ErrorDraft) => update({ errors: draft.errors.map((e, j) => (j === i ? next : e)) })
          return (
            <ItemShell
              key={i}
              status={status("errors", item)}
              onRemove={() => update({ errors: draft.errors.filter((_, j) => j !== i) })}
            >
              <Textarea
                placeholder="Quando si verifica"
                value={item.condition}
                onChange={(event) => set({ ...item, condition: event.target.value })}
              />
              <Input
                placeholder="Messaggio mostrato all'utente (facoltativo)"
                value={item.message ?? ""}
                onChange={(event) => set({ ...item, message: event.target.value })}
              />
              {refs(item.references, (references) => set({ ...item, references }))}
            </ItemShell>
          )
        })}
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="self-start"
          onClick={() => update({ errors: [...draft.errors, { condition: "", message: null, references: [] }] })}
        >
          <PlusIcon data-icon="inline-start" />
          Aggiungi
        </Button>
      </section>
    </div>
  )
}
