import { queryOptions, useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { FlaskConicalIcon, MessageSquarePlusIcon, SendIcon, SquareIcon, Trash2Icon } from "lucide-react"
import { type KeyboardEvent, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { AssistantMessage, UserMessage } from "@/components/chat/chat-message"
import { PageHeader } from "@/components/page-header"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Textarea } from "@/components/ui/textarea"
import { getProject } from "@/functions/projects.functions"
import {
  deleteConversation,
  getConversation,
  getIndexStatus,
  getRagStatus,
  listConversations
} from "@/functions/rag.functions"
import { useChat } from "@/hooks/use-chat"
import { formatDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"

const projectQuery = (projectId: string) =>
  queryOptions({ queryKey: ["project", projectId], queryFn: () => getProject({ data: { projectId } }) })

export const Route = createFileRoute("/_app/projects/$projectId_/chat")({
  loader: ({ context, params }) =>
    context.queryClient.query({ ...projectQuery(params.projectId), staleTime: "static" }),
  head: () => ({ meta: [{ title: "Chat · Code-to-RAG" }] }),
  component: ChatPage
})

function ChatPage() {
  const { projectId } = Route.useParams()
  const { data: summary } = useSuspenseQuery(projectQuery(projectId))
  const snapshot = summary.latestSnapshot
  const ready = snapshot?.understandingStatus === "ready"

  return (
    <>
      <PageHeader
        title="Chat"
        breadcrumbs={[
          { label: "Progetti", to: "/projects" },
          { label: summary.project.name, to: "/projects/$projectId", params: { projectId } },
          { label: "Chat" }
        ]}
        description="Risposte basate sulle schede funzionali del progetto, con le fonti citate."
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link to="/projects/$projectId/tests" params={{ projectId }}>
              <FlaskConicalIcon data-icon="inline-start" />
              Domande di test
            </Link>
          </Button>
        }
      />
      {snapshot === null || !ready ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>Schede non ancora disponibili</EmptyTitle>
            <EmptyDescription>La chat risponde a partire dalle schede: genera le schede del progetto.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Chat projectId={projectId} snapshotId={snapshot.id} />
      )}
    </>
  )
}

function IndexNotice({ snapshotId }: { snapshotId: string }) {
  const rag = useQuery({ queryKey: ["rag-status"], queryFn: () => getRagStatus(), staleTime: 60_000 })
  const index = useQuery({
    queryKey: ["index-status", snapshotId],
    queryFn: () => getIndexStatus({ data: { snapshotId } }),
    refetchInterval: (query) =>
      query.state.data !== undefined && query.state.data.indexedCards < query.state.data.indexableCards ? 5000 : false
  })
  if (rag.data === undefined || index.data === undefined) return null
  if (rag.data.chatModel === null || rag.data.embeddingModel === null) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Chat non disponibile</AlertTitle>
        <AlertDescription>
          Configura {rag.data.chatModel === null ? "AI_MODEL" : ""}
          {rag.data.chatModel === null && rag.data.embeddingModel === null ? " e " : ""}
          {rag.data.embeddingModel === null ? "EMBEDDING_MODEL" : ""} sul server.
        </AlertDescription>
      </Alert>
    )
  }
  const { indexedCards, indexableCards } = index.data
  if (indexedCards >= indexableCards) return null
  return (
    <Alert>
      <AlertTitle>Indice in aggiornamento</AlertTitle>
      <AlertDescription>
        {indexedCards} di {indexableCards} schede indicizzate: le risposte potrebbero non considerare le altre.
      </AlertDescription>
    </Alert>
  )
}

function Chat({ projectId, snapshotId }: { projectId: string; snapshotId: string }) {
  const queryClient = useQueryClient()
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [question, setQuestion] = useState("")
  const [approvedOnly, setApprovedOnly] = useState(false)
  const bottom = useRef<HTMLDivElement>(null)

  const conversations = useQuery({
    queryKey: ["conversations", projectId],
    queryFn: () => listConversations({ data: { projectId } })
  })
  const conversation = useQuery({
    queryKey: ["conversation", conversationId],
    queryFn: () => getConversation({ data: { conversationId: conversationId! } }),
    enabled: conversationId !== null
  })

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["conversation"] })
    void queryClient.invalidateQueries({ queryKey: ["conversations", projectId] })
  }
  const chat = useChat({
    onConversation: (created) => {
      setConversationId(created.id)
      void queryClient.invalidateQueries({ queryKey: ["conversations", projectId] })
    },
    onSettled: (stored) => {
      refresh()
      // A stopped answer is stored by the server just after the connection closes.
      if (stored === undefined) setTimeout(refresh, 1000)
    }
  })

  const remove = useMutation({
    mutationFn: (id: string) => deleteConversation({ data: { conversationId: id } }),
    onSuccess: (_, id) => {
      if (id === conversationId) {
        chat.reset()
        setConversationId(null)
      }
      void queryClient.invalidateQueries({ queryKey: ["conversations", projectId] })
    },
    onError: (error) => toast.error(error.message)
  })

  const messages = conversationId === null ? [] : (conversation.data?.messages ?? [])
  const pending = chat.pending

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" })
  }, [messages.length, pending?.text, pending?.sources.length])

  const send = () => {
    const text = question.trim()
    if (text === "" || chat.streaming) return
    setQuestion("")
    void chat.send({ projectId, conversationId, question: text, approvedOnly })
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      send()
    }
  }
  const startNew = () => {
    chat.reset()
    setConversationId(null)
  }

  return (
    <div className="flex flex-col gap-3">
      <IndexNotice snapshotId={snapshotId} />
      <div className="grid gap-4 lg:grid-cols-[minmax(220px,280px)_1fr]">
        <Card className="gap-2 py-3">
          <div className="px-3">
            <Button variant="outline" size="sm" className="w-full" onClick={startNew} disabled={chat.streaming}>
              <MessageSquarePlusIcon data-icon="inline-start" />
              Nuova conversazione
            </Button>
          </div>
          <ScrollArea className="max-h-[65vh]">
            <ul className="flex flex-col px-2">
              {(conversations.data ?? []).map((item) => (
                <li key={item.id} className="group flex items-center gap-1">
                  <button
                    type="button"
                    disabled={chat.streaming}
                    onClick={() => {
                      chat.reset()
                      setConversationId(item.id)
                    }}
                    className={cn(
                      "flex min-w-0 flex-1 flex-col rounded-md px-2 py-1.5 text-left hover:bg-muted",
                      item.id === conversationId && "bg-muted"
                    )}
                  >
                    <span className="truncate text-sm">{item.title}</span>
                    <span className="text-[11px] text-muted-foreground">{formatDateTime(item.updatedAt)}</span>
                  </button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    aria-label="Elimina conversazione"
                    disabled={remove.isPending || chat.streaming}
                    onClick={() => remove.mutate(item.id)}
                  >
                    <Trash2Icon />
                  </Button>
                </li>
              ))}
              {conversations.data?.length === 0 && (
                <li className="px-2 py-1.5 text-xs text-muted-foreground">Nessuna conversazione</li>
              )}
            </ul>
          </ScrollArea>
        </Card>

        <Card className="flex h-[70vh] min-h-[420px] flex-col gap-0 py-0">
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-4 p-4">
              {messages.length === 0 && pending === undefined && (
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>Fai una domanda sull'applicativo</EmptyTitle>
                    <EmptyDescription>
                      Ad esempio come si configura una funzionalità, quali limiti ha o cosa significa un errore. Le
                      risposte citano le schede usate.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
              {messages.map((message) =>
                message.role === "user" ? (
                  <UserMessage key={message.id} text={message.content} />
                ) : (
                  <AssistantMessage
                    key={message.id}
                    id={message.id}
                    projectId={projectId}
                    text={message.content}
                    sources={message.sources}
                    citations={message.citations}
                    status={message.status}
                    model={message.model}
                  />
                )
              )}
              {pending !== undefined && (
                <>
                  {/* The question is stored at once, but the conversation is reloaded only at the end. */}
                  {messages.at(-1)?.content !== pending.question && <UserMessage text={pending.question} />}
                  <AssistantMessage
                    id="pending"
                    projectId={projectId}
                    text={pending.text}
                    sources={pending.sources}
                    citations={[]}
                    status={undefined}
                  />
                </>
              )}
              {chat.error !== undefined && (
                <Alert variant="destructive">
                  <AlertTitle>Risposta non riuscita</AlertTitle>
                  <AlertDescription>{chat.error}</AlertDescription>
                </Alert>
              )}
              <div ref={bottom} />
            </div>
          </ScrollArea>
          <div className="flex flex-col gap-2 border-t p-3">
            <Textarea
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Scrivi una domanda… (Invio per inviare, Maiusc+Invio per andare a capo)"
              className="max-h-40 min-h-16 resize-none"
              maxLength={4000}
            />
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="approved-only"
                  checked={approvedOnly}
                  onCheckedChange={(checked) => setApprovedOnly(checked === true)}
                />
                <Label htmlFor="approved-only" className="text-xs font-normal text-muted-foreground">
                  Solo schede approvate
                </Label>
              </div>
              {chat.streaming ? (
                <Button size="sm" variant="outline" onClick={chat.stop}>
                  <SquareIcon data-icon="inline-start" />
                  Interrompi
                </Button>
              ) : (
                <Button size="sm" onClick={send} disabled={question.trim() === ""}>
                  <SendIcon data-icon="inline-start" />
                  Invia
                </Button>
              )}
            </div>
          </div>
        </Card>
      </div>
    </div>
  )
}
