import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { Trash2Icon } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import { removeProject } from "@/functions/review.functions"

/** Deletion of a project: everything it produced goes, so the name must be typed again. */
export function DeleteProjectDialog({
  projectId,
  projectName,
  disabled
}: {
  projectId: string
  projectName: string
  disabled: boolean
}) {
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState("")
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const remove = useMutation({
    mutationFn: () => removeProject({ data: { projectId, confirmName: typed } }),
    onSuccess: async () => {
      setOpen(false)
      toast.success(`Progetto «${projectName}» eliminato`)
      queryClient.removeQueries({ queryKey: ["project", projectId] })
      await queryClient.invalidateQueries({ queryKey: ["projects"] })
      await navigate({ to: "/projects" })
    },
    onError: (error) => toast.error(error.message)
  })

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setTyped("")
      }}
    >
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled} className="text-destructive">
          <Trash2Icon data-icon="inline-start" />
          Elimina progetto
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Eliminare il progetto?</AlertDialogTitle>
          <AlertDialogDescription>
            Vengono eliminati definitivamente codice acquisito, analisi, riassunti, funzionalità, schede, correzioni e
            job del progetto. Il registro delle chiamate al modello resta. L'operazione non si può annullare.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="confirm-project-name">
            Per confermare scrivi <span className="font-semibold">{projectName}</span>
          </Label>
          <Input
            id="confirm-project-name"
            autoComplete="off"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Annulla</AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={typed.trim() !== projectName || remove.isPending}
            onClick={() => remove.mutate()}
          >
            {remove.isPending && <Spinner data-icon="inline-start" />}
            Elimina
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
