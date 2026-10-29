import { useQuery } from "@tanstack/react-query"
import { DownloadIcon } from "lucide-react"
import { useState } from "react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from "@/components/ui/dialog"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle
} from "@/components/ui/field"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Skeleton } from "@/components/ui/skeleton"
import { getExportPreview } from "@/functions/export.functions"

type Format = "jsonl" | "sql"
type Preview = Awaited<ReturnType<typeof getExportPreview>>

function Choice({ value, title, description }: { value: string; title: string; description: string }) {
  return (
    <FieldLabel htmlFor={`export-${value}`}>
      <Field orientation="horizontal">
        <RadioGroupItem value={value} id={`export-${value}`} />
        <FieldContent>
          <FieldTitle>{title}</FieldTitle>
          <FieldDescription>{description}</FieldDescription>
        </FieldContent>
      </Field>
    </FieldLabel>
  )
}

function Contents({ preview }: { preview: Preview }) {
  const { rows, embeddings } = preview
  const items = [
    [rows.card, "schede"],
    [rows.feature, "funzionalità"],
    [rows.chunk, "chunk dell'indice"],
    [rows.correction, "correzioni"],
    [rows.test_question, "domande di test"],
    [rows.test_run, "esecuzioni dei test"],
    [rows.file_summary + rows.module_summary, "riassunti di file e moduli"]
  ] as const
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3 text-sm">
      <ul className="grid grid-cols-2 gap-x-4 gap-y-1">
        {items.map(([count, label]) => (
          <li key={label}>
            <span className="font-medium tabular-nums">{count}</span>{" "}
            <span className="text-muted-foreground">{label}</span>
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground">
        {embeddings.length === 0
          ? "Nessun embedding: l'indice non è stato costruito."
          : `Embedding: ${embeddings.map((embedding) => `${embedding.model} (${embedding.dimensions} dimensioni)`).join(", ")}. Le domande vanno trasformate in vettori con lo stesso modello.`}
      </p>
    </div>
  )
}

/** Download of the knowledge of the version in use: JSONL archive or SQL script for another Postgres. */
export function ExportDialog({ projectId, disabled }: { projectId: string; disabled: boolean }) {
  const [open, setOpen] = useState(false)
  const [format, setFormat] = useState<Format>("jsonl")
  const [approvedOnly, setApprovedOnly] = useState(false)
  const preview = useQuery({
    queryKey: ["export-preview", projectId, approvedOnly],
    queryFn: () => getExportPreview({ data: { projectId, approvedOnly } }),
    enabled: open,
    staleTime: 0,
    retry: false
  })
  const href = `/api/projects/${encodeURIComponent(projectId)}/export?${new URLSearchParams({
    format,
    approvedOnly: String(approvedOnly)
  }).toString()}`
  const empty = preview.data !== undefined && preview.data.rows.card === 0

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled}>
          <DownloadIcon data-icon="inline-start" />
          Esporta
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Esporta la conoscenza</DialogTitle>
          <DialogDescription>
            Schede, funzionalità, riferimenti, verifiche, correzioni, domande di test, riassunti e indice della versione
            in uso. Il codice sorgente non viene esportato.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <FieldSet>
            <FieldLegend variant="label">Formato</FieldLegend>
            <RadioGroup value={format} onValueChange={(value) => setFormat(value as Format)}>
              <Choice
                value="jsonl"
                title="Archivio JSONL (.zip)"
                description="manifest.json e un file JSONL per tabella, per altri sistemi RAG o elaborazioni."
              />
              <Choice
                value="sql"
                title="Script SQL (.sql)"
                description="Crea lo schema rag in un altro Postgres (con pgvector) e sostituisce i dati di questo progetto. Si può rieseguire."
              />
            </RadioGroup>
          </FieldSet>
          <FieldSet>
            <FieldLegend variant="label">Schede</FieldLegend>
            <RadioGroup
              value={approvedOnly ? "approved" : "all"}
              onValueChange={(value) => setApprovedOnly(value === "approved")}
            >
              <Choice value="all" title="Tutte tranne le escluse" description="Con il loro stato di revisione." />
              <Choice value="approved" title="Solo approvate" description="Solo le schede approvate da un revisore." />
            </RadioGroup>
          </FieldSet>
        </FieldGroup>
        {preview.error !== null ? (
          <Alert variant="destructive">
            <AlertDescription>{preview.error.message}</AlertDescription>
          </Alert>
        ) : preview.data === undefined ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <>
            <Contents preview={preview.data} />
            {preview.data.indexing && (
              <Alert>
                <AlertDescription>
                  L'indicizzazione è in corso: l'indice esportato potrebbe non comprendere le ultime modifiche.
                </AlertDescription>
              </Alert>
            )}
            {empty && (
              <Alert>
                <AlertDescription>Nessuna scheda da esportare con questa scelta.</AlertDescription>
              </Alert>
            )}
          </>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Annulla
          </Button>
          {preview.data === undefined || empty ? (
            <Button disabled>
              <DownloadIcon data-icon="inline-start" />
              Scarica
            </Button>
          ) : (
            <Button asChild>
              <a href={href} download onClick={() => setOpen(false)}>
                <DownloadIcon data-icon="inline-start" />
                Scarica
              </a>
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
