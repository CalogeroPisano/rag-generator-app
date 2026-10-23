import type { ExclusionReason } from "@code-to-rag/analysis"
import { useQuery } from "@tanstack/react-query"
import { ChevronRightIcon, FileIcon, FolderIcon, FolderXIcon, SearchIcon, ShieldAlertIcon } from "lucide-react"
import { useMemo, useState } from "react"
import { FileDependencies } from "@/components/analysis/file-dependencies"
import { FileOutline } from "@/components/analysis/file-outline"
import { CodeViewer } from "@/components/code/code-viewer"
import type { CodeFocus } from "@/components/code/code-viewer.client"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { getFileAnalysis } from "@/functions/analysis.functions"
import { getFileContent } from "@/functions/projects.functions"
import { cn } from "@/lib/utils"
import { exclusionReasonLabels, formatBytes } from "@/lib/format"

export interface FileEntry {
  readonly path: string
  readonly language: string
  readonly size: number
  readonly isDirectory: boolean
  readonly excludedReason: ExclusionReason | null
  readonly lineCount: number
  readonly secretCount: number
  /** Null when the file was not parsed (language without a grammar, or analysis not run yet). */
  readonly parseErrors: number | null
}

/** A file to show, optionally scrolled to a line range. */
export interface FileSelection {
  readonly path: string
  readonly focus?: CodeFocus | undefined
}

interface TreeNode {
  readonly name: string
  readonly path: string
  readonly children: Map<string, TreeNode>
  entry: FileEntry | undefined
}

const buildTree = (entries: ReadonlyArray<FileEntry>): TreeNode => {
  const root: TreeNode = { name: "", path: "", children: new Map(), entry: undefined }
  for (const entry of entries) {
    let node = root
    const segments = entry.path.split("/")
    segments.forEach((segment, index) => {
      const path = segments.slice(0, index + 1).join("/")
      let child = node.children.get(segment)
      if (child === undefined) {
        child = { name: segment, path, children: new Map(), entry: undefined }
        node.children.set(segment, child)
      }
      node = child
    })
    node.entry = entry
  }
  return root
}

/** Folders (with children) first, then files; alphabetical. */
const sortedChildren = (node: TreeNode) =>
  [...node.children.values()].sort((a, b) => {
    const aFolder = a.children.size > 0 ? 0 : 1
    const bFolder = b.children.size > 0 ? 0 : 1
    return aFolder - bFolder || a.name.localeCompare(b.name)
  })

function ExclusionBadge({ reason }: { reason: ExclusionReason }) {
  const { label, description } = exclusionReasonLabels[reason]
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className="ml-auto text-muted-foreground">
          {label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="right">{description}</TooltipContent>
    </Tooltip>
  )
}

function SecretsMarker({ count }: { count: number }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="ml-auto flex items-center gap-1 text-xs text-warning">
          <ShieldAlertIcon className="size-3.5" /> {count}
        </span>
      </TooltipTrigger>
      <TooltipContent side="right">
        {count === 1 ? "1 credenziale mascherata" : `${count} credenziali mascherate`}
      </TooltipContent>
    </Tooltip>
  )
}

function FileRow({
  node,
  depth,
  selected,
  onSelect,
  label = node.name
}: {
  node: TreeNode
  depth: number
  selected: string | undefined
  onSelect: (entry: FileEntry) => void
  label?: string
}) {
  const entry = node.entry!
  const excluded = entry.excludedReason !== null
  const Icon = entry.isDirectory ? FolderXIcon : FileIcon
  return (
    <button
      type="button"
      onClick={() => onSelect(entry)}
      style={{ paddingLeft: `${depth * 12 + 8}px` }}
      className={cn(
        "flex w-full items-center gap-1.5 rounded-sm py-1 pr-2 text-left text-sm hover:bg-muted",
        selected === entry.path && "bg-muted font-medium",
        excluded && "text-muted-foreground"
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
      {entry.excludedReason !== null && <ExclusionBadge reason={entry.excludedReason} />}
      {entry.excludedReason === null && entry.secretCount > 0 && <SecretsMarker count={entry.secretCount} />}
    </button>
  )
}

function FolderNode({
  node,
  depth,
  selected,
  onSelect
}: {
  node: TreeNode
  depth: number
  selected: string | undefined
  onSelect: (entry: FileEntry) => void
}) {
  const containsSelected = selected?.startsWith(`${node.path}/`) ?? false
  const [open, setOpen] = useState(depth === 0 || containsSelected)
  // A file selected elsewhere (symbols, dependencies) opens the folders leading to it.
  const [lastSelected, setLastSelected] = useState(selected)
  if (selected !== lastSelected) {
    setLastSelected(selected)
    if (containsSelected) setOpen(true)
  }
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        className="group flex w-full items-center gap-1.5 rounded-sm py-1 pr-2 text-left text-sm hover:bg-muted"
      >
        <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
        <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">{node.name}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <TreeLevel node={node} depth={depth + 1} selected={selected} onSelect={onSelect} />
      </CollapsibleContent>
    </Collapsible>
  )
}

function TreeLevel({
  node,
  depth,
  selected,
  onSelect
}: {
  node: TreeNode
  depth: number
  selected: string | undefined
  onSelect: (entry: FileEntry) => void
}) {
  return (
    <>
      {sortedChildren(node).map((child) =>
        child.children.size > 0 ? (
          <FolderNode key={child.path} node={child} depth={depth} selected={selected} onSelect={onSelect} />
        ) : (
          <FileRow key={child.path} node={child} depth={depth} selected={selected} onSelect={onSelect} />
        )
      )}
    </>
  )
}

type PreviewTab = "code" | "outline" | "dependencies"

function FilePreview({
  snapshotId,
  entry,
  focus,
  analysisReady,
  onOpen
}: {
  snapshotId: string
  entry: FileEntry | undefined
  focus: CodeFocus | undefined
  analysisReady: boolean
  onOpen: (selection: FileSelection) => void
}) {
  const included = entry !== undefined && entry.excludedReason === null
  const analyzed = included && analysisReady && entry.parseErrors !== null
  const content = useQuery({
    queryKey: ["file", snapshotId, entry?.path],
    queryFn: () => getFileContent({ data: { snapshotId, path: entry!.path } }),
    enabled: included,
    staleTime: Infinity
  })
  const analysis = useQuery({
    queryKey: ["file-analysis", snapshotId, entry?.path],
    queryFn: () => getFileAnalysis({ data: { snapshotId, path: entry!.path } }),
    enabled: analyzed,
    staleTime: Infinity
  })

  const [tab, setTab] = useState<PreviewTab>("code")
  // Showing another file, or jumping to a symbol, brings the code back.
  const [shown, setShown] = useState({ path: entry?.path, focusKey: focus?.key })
  if (shown.path !== entry?.path || shown.focusKey !== focus?.key) {
    setShown({ path: entry?.path, focusKey: focus?.key })
    setTab("code")
  }

  if (entry === undefined) {
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FileIcon />
          </EmptyMedia>
          <EmptyTitle>Nessun file selezionato</EmptyTitle>
          <EmptyDescription>Scegli un file dall'albero per vederne il contenuto (già mascherato).</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  if (entry.excludedReason !== null) {
    const { label, description } = exclusionReasonLabels[entry.excludedReason]
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyMedia variant="icon">{entry.isDirectory ? <FolderXIcon /> : <FileIcon />}</EmptyMedia>
          <EmptyTitle>Escluso dall'analisi: {label.toLowerCase()}</EmptyTitle>
          <EmptyDescription>
            {description}
            {entry.size > 0 && ` Dimensione: ${formatBytes(entry.size)}.`}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  if (content.isError) {
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyTitle>Impossibile caricare il file</EmptyTitle>
          <EmptyDescription>{content.error.message}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  if (content.data === undefined) return <Skeleton className="h-full w-full rounded-none" />
  const code = (
    <CodeViewer
      path={content.data.path}
      language={content.data.language}
      content={content.data.content}
      secretLines={content.data.secrets.map((secret) => secret.line)}
      focus={focus}
    />
  )
  if (!analyzed) return code

  const symbols = analysis.data?.symbols ?? []
  const dependencyCount = (analysis.data?.imports.length ?? 0) + (analysis.data?.importedBy.length ?? 0)
  return (
    <Tabs value={tab} onValueChange={(value) => setTab(value as PreviewTab)} className="flex h-full flex-col gap-0">
      <div className="border-b px-3 py-2">
        <TabsList>
          <TabsTrigger value="code">Codice</TabsTrigger>
          <TabsTrigger value="outline">Struttura ({symbols.length})</TabsTrigger>
          <TabsTrigger value="dependencies">Dipendenze ({dependencyCount})</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="code" className="min-h-0 flex-1">
        {code}
      </TabsContent>
      <TabsContent value="outline" className="min-h-0 flex-1">
        <ScrollArea className="h-full">
          {analysis.data === undefined ? (
            <Skeleton className="m-3 h-40" />
          ) : (
            <FileOutline
              symbols={symbols}
              onSelect={(symbol) =>
                onOpen({
                  path: entry.path,
                  focus: { startLine: symbol.startLine, endLine: symbol.endLine, key: Date.now() }
                })
              }
            />
          )}
        </ScrollArea>
      </TabsContent>
      <TabsContent value="dependencies" className="min-h-0 flex-1">
        <ScrollArea className="h-full">
          {analysis.data === undefined ? (
            <Skeleton className="m-3 h-40" />
          ) : (
            <FileDependencies analysis={analysis.data} onOpenFile={(path) => onOpen({ path })} />
          )}
        </ScrollArea>
      </TabsContent>
    </Tabs>
  )
}

type Filter = "all" | "included" | "excluded"

export function FileExplorer({
  snapshotId,
  entries,
  analysisReady,
  selection,
  onSelectionChange
}: {
  snapshotId: string
  entries: ReadonlyArray<FileEntry>
  analysisReady: boolean
  selection: FileSelection | undefined
  onSelectionChange: (selection: FileSelection) => void
}) {
  const [filter, setFilter] = useState<Filter>("all")
  const [search, setSearch] = useState("")
  const byPath = useMemo(() => new Map(entries.map((entry) => [entry.path, entry])), [entries])
  const selected = selection === undefined ? undefined : byPath.get(selection.path)
  const select = (entry: FileEntry) => onSelectionChange({ path: entry.path })

  const counts = useMemo(
    () => ({
      all: entries.length,
      included: entries.filter((entry) => entry.excludedReason === null).length,
      excluded: entries.filter((entry) => entry.excludedReason !== null).length
    }),
    [entries]
  )
  const visible = useMemo(
    () =>
      entries.filter(
        (entry) =>
          (filter === "all" || (filter === "included") === (entry.excludedReason === null)) &&
          (search === "" || entry.path.toLowerCase().includes(search.toLowerCase()))
      ),
    [entries, filter, search]
  )
  const tree = useMemo(() => buildTree(visible), [visible])

  return (
    <Card className="grid h-[70vh] min-h-[480px] grid-cols-1 gap-0 overflow-hidden py-0 md:grid-cols-[minmax(260px,340px)_1fr]">
      <div className="flex min-h-0 flex-col border-b md:border-r md:border-b-0">
        <div className="flex flex-col gap-2 border-b p-3">
          <div className="relative">
            <SearchIcon className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Cerca file…"
              className="pl-8"
              aria-label="Cerca file"
            />
          </div>
          <Tabs value={filter} onValueChange={(value) => setFilter(value as Filter)}>
            <TabsList className="w-full">
              <TabsTrigger value="all">Tutti ({counts.all})</TabsTrigger>
              <TabsTrigger value="included">Inclusi ({counts.included})</TabsTrigger>
              <TabsTrigger value="excluded">Esclusi ({counts.excluded})</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="p-1">
            {search !== "" ? (
              visible.map((entry) => (
                <FileRow
                  key={entry.path}
                  node={{ name: entry.path, path: entry.path, children: new Map(), entry }}
                  label={entry.path}
                  depth={0}
                  selected={selected?.path}
                  onSelect={select}
                />
              ))
            ) : (
              <TreeLevel node={tree} depth={0} selected={selected?.path} onSelect={select} />
            )}
            {visible.length === 0 && <p className="p-4 text-center text-sm text-muted-foreground">Nessun file</p>}
          </div>
        </ScrollArea>
      </div>
      <div className="flex min-h-0 min-w-0 flex-col">
        {selected !== undefined && (
          <div className="flex items-center gap-2 border-b px-3 py-2 text-sm">
            <span className="min-w-0 truncate font-mono text-xs">{selected.path}</span>
            {selected.excludedReason === null && (
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                {selected.lineCount} righe · {formatBytes(selected.size)}
                {selected.parseErrors !== null && selected.parseErrors > 0 && " · errori di sintassi"}
              </span>
            )}
          </div>
        )}
        <div className="min-h-0 flex-1">
          <FilePreview
            snapshotId={snapshotId}
            entry={selected}
            focus={selection?.focus}
            analysisReady={analysisReady}
            onOpen={onSelectionChange}
          />
        </div>
      </div>
    </Card>
  )
}
