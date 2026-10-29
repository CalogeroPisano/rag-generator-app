import { useMutation, useQueryClient } from "@tanstack/react-query"
import { type ReactNode, useState } from "react"
import { toast } from "sonner"
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
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { createTestQuestion, saveTestQuestion } from "@/functions/rag.functions"

export interface QuestionDraft {
  readonly id: string | null
  readonly featureId: string
  readonly question: string
  readonly expectedAnswer: string
}

/** Adds a test question, or edits one (`initial.id` set). */
export function QuestionDialog({
  snapshotId,
  features,
  initial,
  trigger
}: {
  snapshotId: string
  features: ReadonlyArray<{ readonly id: string; readonly name: string }>
  initial: QuestionDraft
  trigger: ReactNode
}) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(initial)

  const save = useMutation({
    mutationFn: () => {
      const input = {
        featureId: draft.featureId,
        question: draft.question,
        expectedAnswer: draft.expectedAnswer.trim() === "" ? null : draft.expectedAnswer
      }
      return draft.id === null
        ? createTestQuestion({ data: { snapshotId, input } })
        : saveTestQuestion({ data: { snapshotId, questionId: draft.id, input } })
    },
    onSuccess: () => {
      toast.success(draft.id === null ? "Domanda aggiunta" : "Domanda aggiornata")
      setOpen(false)
      void queryClient.invalidateQueries({ queryKey: ["test-questions", snapshotId] })
    },
    onError: (error) => toast.error(error.message)
  })

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setDraft(initial)
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{initial.id === null ? "Nuova domanda di test" : "Modifica domanda"}</DialogTitle>
          <DialogDescription>
            Una domanda che un utente potrebbe fare alla chat e la funzionalità la cui scheda contiene la risposta.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="question-feature">Funzionalità</FieldLabel>
            <Select value={draft.featureId} onValueChange={(featureId) => setDraft({ ...draft, featureId })}>
              <SelectTrigger id="question-feature" className="w-full">
                <SelectValue placeholder="Scegli la funzionalità" />
              </SelectTrigger>
              <SelectContent>
                {features.map((feature) => (
                  <SelectItem key={feature.id} value={feature.id}>
                    {feature.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="question-text">Domanda</FieldLabel>
            <Textarea
              id="question-text"
              value={draft.question}
              maxLength={2000}
              onChange={(event) => setDraft({ ...draft, question: event.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="question-answer">Risposta attesa</FieldLabel>
            <Textarea
              id="question-answer"
              value={draft.expectedAnswer}
              maxLength={4000}
              onChange={(event) => setDraft({ ...draft, expectedAnswer: event.target.value })}
            />
            <FieldDescription>Facoltativa: aiuta la valutazione automatica della risposta.</FieldDescription>
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button
            onClick={() => save.mutate()}
            disabled={save.isPending || draft.featureId === "" || draft.question.trim().length < 3}
          >
            {save.isPending && <Spinner data-icon="inline-start" />}
            Salva
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
