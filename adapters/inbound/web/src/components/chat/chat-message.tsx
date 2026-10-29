import { type ChatSource } from "@code-to-rag/core"
import { BotIcon, UserIcon } from "lucide-react"
import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import { AnswerText } from "./answer-text"
import { ChatSources } from "./chat-sources"

export function UserMessage({ text }: { text: string }) {
  return (
    <div className="flex justify-end gap-2">
      <div className="max-w-[85%] rounded-lg bg-primary px-3 py-2 text-sm whitespace-pre-wrap text-primary-foreground">
        {text}
      </div>
      <UserIcon className="mt-2 size-4 shrink-0 text-muted-foreground" />
    </div>
  )
}

/** An answer with its sources; `status` is absent while it is being streamed. */
export function AssistantMessage({
  id,
  projectId,
  text,
  sources,
  citations,
  status,
  model
}: {
  id: string
  projectId: string
  text: string
  sources: ReadonlyArray<ChatSource>
  citations: ReadonlyArray<number>
  status: "complete" | "failed" | "interrupted" | undefined
  model?: string | null | undefined
}) {
  const [highlighted, setHighlighted] = useState<number | undefined>()
  const cite = (n: number) => {
    setHighlighted(n)
    document.getElementById(`${id}-source-${n}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }
  return (
    <div className="flex gap-2">
      <BotIcon className="mt-2 size-4 shrink-0 text-muted-foreground" />
      <div className="flex max-w-[85%] min-w-0 flex-col gap-3 rounded-lg border bg-card px-3 py-2">
        {text === "" && status === undefined ? (
          <span className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> {sources.length === 0 ? "Ricerca nelle schede…" : "Il modello sta scrivendo…"}
          </span>
        ) : (
          <AnswerText text={text === "" ? "(nessuna risposta)" : text} sourceCount={sources.length} onCite={cite} />
        )}
        {(status === "failed" || status === "interrupted") && (
          <Badge variant={status === "failed" ? "destructive" : "warning"} className="self-start">
            {status === "failed" ? "Risposta non completata: errore del modello" : "Risposta interrotta"}
          </Badge>
        )}
        <ChatSources
          idPrefix={`${id}-source`}
          projectId={projectId}
          sources={sources}
          // While streaming every source is shown as a candidate: citations are known at the end.
          citations={status === undefined ? sources.map((_, i) => i + 1) : citations}
          highlighted={highlighted}
        />
        {model !== undefined && model !== null && <span className="text-[11px] text-muted-foreground">{model}</span>}
      </div>
    </div>
  )
}
