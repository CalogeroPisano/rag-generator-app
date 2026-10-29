import { useQueryClient } from "@tanstack/react-query"
import { GitPullRequestArrowIcon, UploadIcon } from "lucide-react"
import { useRef, useState } from "react"
import { toast } from "sonner"
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
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import { startNewVersion } from "@/functions/projects.functions"
import { formatBytes } from "@/lib/format"
import { uploadArchive } from "@/lib/upload"

/**
 * New version of the code: a new archive for zip projects, the latest commit
 * of the branch for Git projects. The version in use stays available until the
 * update is complete.
 */
export function NewVersionDialog({
  projectId,
  sourceType,
  repositoryRef,
  hasCards,
  disabled
}: {
  projectId: string
  sourceType: "zip" | "git"
  repositoryRef: string | null
  hasCards: boolean
  disabled: boolean
}) {
  const queryClient = useQueryClient()
  const fileInput = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [file, setFile] = useState<File | undefined>()
  const [uploadProgress, setUploadProgress] = useState<number | undefined>()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | undefined>()

  const reset = () => {
    setFile(undefined)
    setUploadProgress(undefined)
    setError(undefined)
  }

  const submit = async () => {
    setError(undefined)
    setPending(true)
    try {
      let uploadId: string | null = null
      if (sourceType === "zip") {
        if (file === undefined) throw new Error("Seleziona l'archivio della nuova versione")
        setUploadProgress(0)
        uploadId = await uploadArchive(file, setUploadProgress)
      }
      await startNewVersion({ data: { projectId, uploadId } })
      toast.info("Nuova versione: acquisizione avviata")
      setOpen(false)
      reset()
      await queryClient.invalidateQueries({ queryKey: ["project", projectId] })
      await queryClient.invalidateQueries({ queryKey: ["versions", projectId] })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Operazione non riuscita")
      setUploadProgress(undefined)
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return
        setOpen(next)
        if (!next) reset()
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled}>
          <GitPullRequestArrowIcon data-icon="inline-start" />
          Nuova versione
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nuova versione del codice</DialogTitle>
          <DialogDescription>
            {sourceType === "git"
              ? `Viene scaricato l'ultimo commit di ${repositoryRef ?? "branch predefinito"}.`
              : "Carica l'archivio zip con il codice aggiornato."}{" "}
            {hasCards
              ? "Riassunti e schede delle parti non modificate vengono riusati; le schede dei file cambiati vengono aggiornate e quelle già approvate tornano da riverificare."
              : "La nuova versione viene acquisita e analizzata."}{" "}
            Fino al termine restano in uso la versione attuale, la chat e i test. Se il codice non è cambiato non viene
            creato nulla.
          </DialogDescription>
        </DialogHeader>
        {error !== undefined && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {sourceType === "zip" && (
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault()
                const dropped = event.dataTransfer.files[0]
                if (dropped !== undefined) setFile(dropped)
              }}
              className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-6 text-center text-sm transition-colors hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              <UploadIcon className="size-6 text-muted-foreground" />
              {file === undefined ? (
                <span className="text-muted-foreground">Trascina qui il file .zip o fai clic per sceglierlo</span>
              ) : (
                <span>
                  <span className="font-medium">{file.name}</span>{" "}
                  <span className="text-muted-foreground">({formatBytes(file.size)})</span>
                </span>
              )}
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".zip,application/zip"
              className="sr-only"
              aria-label="Archivio della nuova versione"
              onChange={(event) => setFile(event.target.files?.[0])}
            />
            {uploadProgress !== undefined && (
              <div className="flex items-center gap-3">
                <Progress value={uploadProgress * 100} className="flex-1" />
                <span className="w-12 text-right text-xs text-muted-foreground tabular-nums">
                  {Math.round(uploadProgress * 100)}%
                </span>
              </div>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
            Annulla
          </Button>
          <Button onClick={() => void submit()} disabled={pending || (sourceType === "zip" && file === undefined)}>
            {pending && <Spinner data-icon="inline-start" />}
            {sourceType === "git" ? "Scarica e aggiorna" : "Carica e aggiorna"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
