import { PlusIcon, SaveIcon, Trash2Icon, TriangleAlertIcon } from "lucide-react"
import { useState } from "react"
import { ConfirmAction } from "@/components/review/confirm-action"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { getSettings } from "@/functions/settings.functions"
import { formatDateTime } from "@/lib/format"

type View = Awaited<ReturnType<typeof getSettings>>["settings"]
type Mutable<T> = { -readonly [K in keyof T]: T[K] extends ReadonlyArray<infer U> ? Array<Mutable<U>> : Mutable<T[K]> }
type Connection = Mutable<View["connections"][number]>
type Preset = Connection["preset"]
type Task = "summaries" | "cards" | "chat"
type TaskModel = Mutable<NonNullable<View["tasks"]["summaries"]>>

export interface SettingsDraft {
  connections: Array<Connection>
  tasks: Record<Task, TaskModel | null>
  embedding: Mutable<NonNullable<View["embedding"]>> | null
  decision: Mutable<View["decision"]>
  /** By connection id: a string sets the key, null removes it, absent keeps it. */
  apiKeys: Record<string, string | null>
}

const copy = (model: View["tasks"]["summaries"]): TaskModel | null => (model === null ? null : { ...model })

export const toSettingsDraft = (view: View): SettingsDraft => ({
  connections: view.connections.map((connection) => ({ ...connection })),
  tasks: { summaries: copy(view.tasks.summaries), cards: copy(view.tasks.cards), chat: copy(view.tasks.chat) },
  embedding: view.embedding === null ? null : { ...view.embedding },
  decision: { ...view.decision },
  apiKeys: {}
})

const PRESETS: ReadonlyArray<{ value: Preset; label: string; baseUrl: string; external: boolean }> = [
  { value: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", external: true },
  {
    value: "gemini",
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    external: true
  },
  { value: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", external: true },
  { value: "mistral", label: "Mistral", baseUrl: "https://api.mistral.ai/v1", external: true },
  { value: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", external: true },
  { value: "ollama", label: "Ollama", baseUrl: "http://localhost:11434/v1", external: false },
  { value: "vllm", label: "vLLM", baseUrl: "http://localhost:8000/v1", external: false },
  { value: "custom", label: "Personalizzato (OpenAI-compatibile)", baseUrl: "", external: false }
]
const presetOf = (value: Preset) => PRESETS.find((preset) => preset.value === value)!

const TASKS: ReadonlyArray<{ task: Task; label: string; description: string }> = [
  {
    task: "summaries",
    label: "Riassunti",
    description: "Riassunti di file e moduli: tante chiamate brevi, va bene un modello veloce ed economico."
  },
  {
    task: "cards",
    label: "Schede",
    description: "Mappa delle funzionalità, schede, mancanze della verifica, domande di test: conta la qualità."
  },
  { task: "chat", label: "Chat", description: "Risposte della chat e giudizio dei test." }
]

const NONE = "__none__"

function NumberField({
  id,
  label,
  value,
  onChange
}: {
  id: string
  label: string
  value: number
  onChange: (value: number) => void
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        min={1}
        value={Number.isFinite(value) ? value : ""}
        onChange={(event) => onChange(Number.parseInt(event.target.value, 10))}
      />
    </div>
  )
}

function ConnectionSelect({
  id,
  connections,
  value,
  allowNone,
  noneLabel,
  onChange
}: {
  id: string
  connections: ReadonlyArray<Connection>
  value: string | null
  allowNone: boolean
  noneLabel: string
  onChange: (value: string | null) => void
}) {
  return (
    <Select value={value ?? NONE} onValueChange={(next) => onChange(next === NONE ? null : next)}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {allowNone && <SelectItem value={NONE}>{noneLabel}</SelectItem>}
        {connections.map((connection) => (
          <SelectItem key={connection.id} value={connection.id}>
            {connection.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** Connections, models per group of tasks, embedding and decision model; saved in one go. */
export function ModelSettingsForm({
  view,
  saving,
  onSave
}: {
  view: View
  saving: boolean
  onSave: (draft: SettingsDraft) => void
}) {
  const [draft, setDraft] = useState(() => toSettingsDraft(view))
  const update = (patch: Partial<SettingsDraft>) => setDraft((current) => ({ ...current, ...patch }))
  const setConnection = (id: string, patch: Partial<Connection>) =>
    update({ connections: draft.connections.map((c) => (c.id === id ? { ...c, ...patch } : c)) })
  const setTask = (task: Task, model: TaskModel | null) => update({ tasks: { ...draft.tasks, [task]: model } })

  const hasKey = (id: string) =>
    draft.apiKeys[id] === undefined ? view.connectionsWithKey.includes(id) : draft.apiKeys[id] !== null
  const inUse = (id: string) =>
    Object.values(draft.tasks).some((model) => model?.connectionId === id) || draft.embedding?.connectionId === id
  const external = draft.connections.filter((c) => presetOf(c.preset).external)
  const embeddingChanged =
    (draft.embedding?.model ?? null) !== (view.embedding?.model ?? null) ||
    (draft.embedding?.connectionId ?? null) !== (view.embedding?.connectionId ?? null)
  const firstConnection = draft.connections[0]?.id

  const addConnection = () => {
    const preset = PRESETS[0]!
    update({
      connections: [
        ...draft.connections,
        {
          id: crypto.randomUUID(),
          name: preset.label,
          preset: preset.value,
          baseUrl: preset.baseUrl,
          structuredOutputs: true,
          concurrency: 2
        }
      ]
    })
  }

  return (
    <div className="flex flex-col gap-6">
      {view.source === "environment" ? (
        <Alert>
          <AlertTitle>Valori dalle variabili d'ambiente</AlertTitle>
          <AlertDescription>
            Nessuna impostazione è stata ancora salvata: i modelli vengono da AI_*, EMBEDDING_* e DECISION_*. Dal primo
            salvataggio vale questa pagina (le API key dell'ambiente vengono conservate cifrate).
          </AlertDescription>
        </Alert>
      ) : (
        <p className="text-sm text-muted-foreground">
          Ultimo salvataggio di {view.updatedBy} · {view.updatedAt === null ? "" : formatDateTime(view.updatedAt)}
        </p>
      )}

      {external.length > 0 && (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>Servizi esterni alla rete</AlertTitle>
          <AlertDescription>
            {external.map((c) => c.name).join(", ")}: a questi servizi arrivano il codice dei progetti (con le
            credenziali mascherate), i riassunti, le schede e le domande della chat. Verifica che il cliente lo consenta
            e le condizioni d'uso dei dati del provider.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Connessioni</CardTitle>
          <CardDescription>
            Endpoint compatibili con l'API OpenAI: OpenRouter, Gemini, OpenAI, Mistral, Groq, Ollama, vLLM o un altro.
            Le API key sono salvate cifrate e non vengono mai mostrate.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {draft.connections.map((connection) => (
            <div key={connection.id} className="flex flex-col gap-3 rounded-md border p-3">
              <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto]">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`name-${connection.id}`}>Nome</Label>
                  <Input
                    id={`name-${connection.id}`}
                    value={connection.name}
                    onChange={(event) => setConnection(connection.id, { name: event.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`preset-${connection.id}`}>Provider</Label>
                  <Select
                    value={connection.preset}
                    onValueChange={(value) => {
                      const preset = presetOf(value as Preset)
                      setConnection(connection.id, {
                        preset: preset.value,
                        ...(preset.baseUrl === "" ? {} : { baseUrl: preset.baseUrl })
                      })
                    }}
                  >
                    <SelectTrigger id={`preset-${connection.id}`} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PRESETS.map((preset) => (
                        <SelectItem key={preset.value} value={preset.value}>
                          {preset.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="self-end"
                  disabled={inUse(connection.id)}
                  title={inUse(connection.id) ? "In uso da un modello" : "Elimina la connessione"}
                  aria-label="Elimina la connessione"
                  onClick={() => update({ connections: draft.connections.filter((c) => c.id !== connection.id) })}
                >
                  <Trash2Icon />
                </Button>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`url-${connection.id}`}>URL dell'API</Label>
                <Input
                  id={`url-${connection.id}`}
                  value={connection.baseUrl}
                  placeholder="https://…/v1"
                  onChange={(event) => setConnection(connection.id, { baseUrl: event.target.value })}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`key-${connection.id}`} className="flex items-center gap-2">
                  API key
                  <Badge variant={hasKey(connection.id) ? "success" : "secondary"}>
                    {hasKey(connection.id) ? "Impostata" : "Nessuna"}
                  </Badge>
                </Label>
                <div className="flex gap-2">
                  <Input
                    id={`key-${connection.id}`}
                    type="password"
                    autoComplete="off"
                    value={draft.apiKeys[connection.id] ?? ""}
                    placeholder={
                      hasKey(connection.id)
                        ? "Lascia vuoto per mantenere quella salvata"
                        : "Necessaria per i servizi esterni"
                    }
                    onChange={(event) =>
                      update({
                        apiKeys:
                          event.target.value === ""
                            ? Object.fromEntries(Object.entries(draft.apiKeys).filter(([id]) => id !== connection.id))
                            : { ...draft.apiKeys, [connection.id]: event.target.value }
                      })
                    }
                  />
                  {view.connectionsWithKey.includes(connection.id) && draft.apiKeys[connection.id] !== null && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => update({ apiKeys: { ...draft.apiKeys, [connection.id]: null } })}
                    >
                      Rimuovi
                    </Button>
                  )}
                </div>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <NumberField
                  id={`concurrency-${connection.id}`}
                  label="Chiamate in parallelo per modello"
                  value={connection.concurrency}
                  onChange={(concurrency) => setConnection(connection.id, { concurrency })}
                />
                <div className="flex items-center gap-2 self-end pb-2">
                  <Checkbox
                    id={`structured-${connection.id}`}
                    checked={connection.structuredOutputs}
                    onCheckedChange={(checked) => setConnection(connection.id, { structuredOutputs: checked === true })}
                  />
                  <Label htmlFor={`structured-${connection.id}`}>Output strutturato (JSON schema)</Label>
                </div>
              </div>
            </div>
          ))}
          <Button type="button" variant="outline" className="self-start" onClick={addConnection}>
            <PlusIcon data-icon="inline-start" />
            Aggiungi connessione
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Modelli per compito</CardTitle>
          <CardDescription>
            L'identificativo del modello è quello del provider (per esempio su OpenRouter "fornitore/modello"). Il
            contesto deve corrispondere a quello reale del modello: i prompt vengono dimensionati su questo valore.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {TASKS.map(({ task, label, description }) => {
            const model = draft.tasks[task]
            return (
              <div key={task} className="flex flex-col gap-3 rounded-md border p-3">
                <div>
                  <p className="font-medium">{label}</p>
                  <p className="text-sm text-muted-foreground">{description}</p>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`connection-${task}`}>Connessione</Label>
                    <ConnectionSelect
                      id={`connection-${task}`}
                      connections={draft.connections}
                      value={model?.connectionId ?? null}
                      allowNone
                      noneLabel="Nessun modello (compito disattivato)"
                      onChange={(connectionId) =>
                        setTask(
                          task,
                          connectionId === null
                            ? null
                            : {
                                model: "",
                                contextTokens: 16_384,
                                maxOutputTokens: 4096,
                                chatMaxOutputTokens: 1024,
                                ...model,
                                connectionId
                              }
                        )
                      }
                    />
                  </div>
                  {model !== null && (
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor={`model-${task}`}>Modello</Label>
                      <Input
                        id={`model-${task}`}
                        value={model.model}
                        placeholder="Identificativo presso il provider"
                        onChange={(event) => setTask(task, { ...model, model: event.target.value })}
                      />
                    </div>
                  )}
                </div>
                {model !== null && (
                  <div className="grid gap-3 md:grid-cols-3">
                    <NumberField
                      id={`context-${task}`}
                      label="Contesto (token)"
                      value={model.contextTokens}
                      onChange={(contextTokens) => setTask(task, { ...model, contextTokens })}
                    />
                    {task === "chat" ? (
                      <NumberField
                        id={`chat-output-${task}`}
                        label="Lunghezza massima della risposta (token)"
                        value={model.chatMaxOutputTokens}
                        onChange={(chatMaxOutputTokens) => setTask(task, { ...model, chatMaxOutputTokens })}
                      />
                    ) : (
                      <NumberField
                        id={`output-${task}`}
                        label="Output massimo (token)"
                        value={model.maxOutputTokens}
                        onChange={(maxOutputTokens) => setTask(task, { ...model, maxOutputTokens })}
                      />
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Embedding</CardTitle>
          <CardDescription>
            Modello multilingue per l'indice e la chat (per esempio bge-m3 su Ollama). Senza modello non ci sono indice
            né chat.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="embedding-connection">Connessione</Label>
            <ConnectionSelect
              id="embedding-connection"
              connections={draft.connections}
              value={draft.embedding?.connectionId ?? null}
              allowNone
              noneLabel="Nessun modello di embedding"
              onChange={(connectionId) =>
                update({
                  embedding:
                    connectionId === null ? null : { model: "", batchSize: 16, ...draft.embedding, connectionId }
                })
              }
            />
          </div>
          {draft.embedding !== null && (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="embedding-model">Modello</Label>
                <Input
                  id="embedding-model"
                  value={draft.embedding.model}
                  onChange={(event) => update({ embedding: { ...draft.embedding!, model: event.target.value } })}
                />
              </div>
              <NumberField
                id="embedding-batch"
                label="Testi per richiesta"
                value={draft.embedding.batchSize}
                onChange={(batchSize) => update({ embedding: { ...draft.embedding!, batchSize } })}
              />
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Modello decisionale</CardTitle>
          <CardDescription>
            Verifica le affermazioni delle schede e separa le funzionalità tecniche. Usa l'API System One di Ollama
            (indirizzo del server senza /v1), per esempio d1-omni.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="decision-url">Server Ollama</Label>
            <Input
              id="decision-url"
              value={draft.decision.baseUrl}
              onChange={(event) => update({ decision: { ...draft.decision, baseUrl: event.target.value } })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="decision-model">Modello</Label>
            <Input
              id="decision-model"
              value={draft.decision.model}
              onChange={(event) => update({ decision: { ...draft.decision, model: event.target.value } })}
            />
          </div>
          <NumberField
            id="decision-context"
            label="Contesto per richiesta (token)"
            value={draft.decision.contextTokens}
            onChange={(contextTokens) => update({ decision: { ...draft.decision, contextTokens } })}
          />
        </CardContent>
      </Card>

      <ConfirmAction
        variant="default"
        disabled={saving || firstConnection === undefined}
        trigger={
          <>
            <SaveIcon data-icon="inline-start" />
            Salva le impostazioni
          </>
        }
        title="Salvare le impostazioni dei modelli?"
        description="Web e worker usano i nuovi modelli entro pochi secondi; le fasi già avviate finiscono con quelli di prima."
        details={
          embeddingChanged ? (
            <p className="text-sm text-warning">
              Il modello di embedding cambia: in ogni progetto l'indice va ricostruito ("Ricostruisci" nella sezione
              della chat), altrimenti la chat non trova le schede.
            </p>
          ) : undefined
        }
        confirmLabel="Salva"
        onConfirm={() => onSave(draft)}
      />
    </div>
  )
}
