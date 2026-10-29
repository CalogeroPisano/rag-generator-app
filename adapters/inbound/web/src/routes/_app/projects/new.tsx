import { useQueryClient } from "@tanstack/react-query"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { FileArchiveIcon, GitBranchIcon, UploadIcon } from "lucide-react"
import { useRef, useState, type SyntheticEvent } from "react"
import { toast } from "sonner"
import { PageHeader } from "@/components/page-header"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { createProjectFn } from "@/functions/projects.functions"
import { formText } from "@/lib/form"
import { formatBytes } from "@/lib/format"
import { uploadArchive } from "@/lib/upload"

export const Route = createFileRoute("/_app/projects/new")({
  head: () => ({ meta: [{ title: "Nuovo progetto · Code-to-RAG" }] }),
  component: NewProjectPage
})

function NewProjectPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const fileInput = useRef<HTMLInputElement>(null)
  const [source, setSource] = useState<"zip" | "git">("zip")
  const [file, setFile] = useState<File | undefined>()
  const [uploadProgress, setUploadProgress] = useState<number | undefined>()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | undefined>()

  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const name = formText(form, "name").trim()
    setError(undefined)
    setPending(true)
    try {
      let summary
      if (source === "zip") {
        if (file === undefined) throw new Error("Seleziona un archivio zip")
        setUploadProgress(0)
        const uploadId = await uploadArchive(file, setUploadProgress)
        summary = await createProjectFn({ data: { name, source: { type: "zip", uploadId } } })
      } else {
        const optional = (key: string) => {
          const value = formText(form, key).trim()
          return value.length > 0 ? value : undefined
        }
        const ref = optional("ref")
        const username = optional("username")
        const token = optional("token")
        summary = await createProjectFn({
          data: {
            name,
            source: {
              type: "git",
              url: formText(form, "url").trim(),
              ...(ref === undefined ? {} : { ref }),
              ...(username === undefined ? {} : { username }),
              ...(token === undefined ? {} : { token })
            }
          }
        })
      }
      await queryClient.invalidateQueries({ queryKey: ["projects"] })
      toast.success("Progetto creato: acquisizione avviata")
      await navigate({ to: "/projects/$projectId", params: { projectId: summary.project.id } })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Operazione non riuscita")
      setUploadProgress(undefined)
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <PageHeader
        title="Nuovo progetto"
        description="Il codice viene filtrato e le credenziali vengono mascherate prima di qualunque analisi."
        breadcrumbs={[{ label: "Progetti", to: "/projects" }, { label: "Nuovo progetto" }]}
      />
      <form onSubmit={(event) => void submit(event)} className="max-w-2xl">
        <Card>
          <CardHeader>
            <CardTitle>Sorgente del codice</CardTitle>
            <CardDescription>Carica un archivio zip oppure indica un repository Git.</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              {error !== undefined && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <Field>
                <FieldLabel htmlFor="name">Nome del progetto</FieldLabel>
                <Input id="name" name="name" maxLength={120} required placeholder="Es. Gestionale ordini" />
              </Field>
              <Tabs value={source} onValueChange={(value) => setSource(value as "zip" | "git")}>
                <TabsList>
                  <TabsTrigger value="zip">
                    <FileArchiveIcon /> Archivio zip
                  </TabsTrigger>
                  <TabsTrigger value="git">
                    <GitBranchIcon /> Repository Git
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="zip" className="pt-4">
                  <Field>
                    <FieldLabel htmlFor="archive">Archivio</FieldLabel>
                    <button
                      type="button"
                      onClick={() => fileInput.current?.click()}
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={(event) => {
                        event.preventDefault()
                        const dropped = event.dataTransfer.files[0]
                        if (dropped !== undefined) setFile(dropped)
                      }}
                      className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-8 text-center text-sm transition-colors hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                    >
                      <UploadIcon className="size-6 text-muted-foreground" />
                      {file === undefined ? (
                        <span className="text-muted-foreground">
                          Trascina qui il file .zip o fai clic per sceglierlo
                        </span>
                      ) : (
                        <span>
                          <span className="font-medium">{file.name}</span>{" "}
                          <span className="text-muted-foreground">({formatBytes(file.size)})</span>
                        </span>
                      )}
                    </button>
                    <input
                      ref={fileInput}
                      id="archive"
                      type="file"
                      accept=".zip,application/zip"
                      className="sr-only"
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
                    <FieldDescription>
                      Dipendenze, output di build, binari e file generati vengono esclusi automaticamente.
                    </FieldDescription>
                  </Field>
                </TabsContent>
                <TabsContent value="git" className="pt-4">
                  <FieldSet>
                    <Field>
                      <FieldLabel htmlFor="url">URL del repository</FieldLabel>
                      <Input
                        id="url"
                        name="url"
                        type="url"
                        placeholder="https://git.example.com/team/progetto.git"
                        required={source === "git"}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="ref">Branch o tag</FieldLabel>
                      <Input id="ref" name="ref" placeholder="Predefinito del repository" />
                    </Field>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field>
                        <FieldLabel htmlFor="username">Utente</FieldLabel>
                        <Input id="username" name="username" autoComplete="off" placeholder="x-access-token" />
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="token">Token di accesso</FieldLabel>
                        <Input id="token" name="token" type="password" autoComplete="off" />
                      </Field>
                    </div>
                    <FieldDescription>
                      Solo per repository privati. Usa un token in sola lettura: viene salvato cifrato e non è mai
                      mostrato né registrato nei log.
                    </FieldDescription>
                  </FieldSet>
                </TabsContent>
              </Tabs>
            </FieldGroup>
          </CardContent>
          <CardFooter className="justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => void navigate({ to: "/projects" })} disabled={pending}>
              Annulla
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Spinner data-icon="inline-start" />}
              {pending && source === "zip" && uploadProgress !== undefined && uploadProgress < 1
                ? "Caricamento…"
                : "Crea progetto"}
            </Button>
          </CardFooter>
        </Card>
      </form>
    </>
  )
}
