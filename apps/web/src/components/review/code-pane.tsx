import { useQuery } from "@tanstack/react-query"
import { CodeViewer } from "@/components/code/code-viewer"
import type { CodeFocus } from "@/components/code/code-viewer.client"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { getFileContent } from "@/functions/projects.functions"
import { fileName, type Reference } from "./statements"

/** Code side of the review: the feature's files as tabs, cited lines marked, the selected range in focus. */
export function CodePane({
  snapshotId,
  files,
  path,
  onPathChange,
  references,
  focus
}: {
  snapshotId: string
  files: ReadonlyArray<string>
  path: string | undefined
  onPathChange: (path: string) => void
  /** Every reference of the card: those of the shown file are marked. */
  references: ReadonlyArray<Reference>
  focus: CodeFocus | undefined
}) {
  const content = useQuery({
    queryKey: ["file", snapshotId, path],
    queryFn: () => getFileContent({ data: { snapshotId, path: path! } }),
    enabled: path !== undefined,
    staleTime: Infinity
  })

  if (path === undefined) {
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyTitle>Nessun file</EmptyTitle>
          <EmptyDescription>La funzionalità non ha file collegati.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  const cited = (file: string) => references.filter((reference) => reference.path === file).length

  return (
    <div className="flex h-full flex-col">
      <div className="overflow-x-auto border-b px-2 py-2">
        <Tabs value={path} onValueChange={onPathChange}>
          <TabsList>
            {files.map((file) => (
              <TabsTrigger key={file} value={file} title={file} className="font-mono text-xs">
                {fileName(file)}
                {cited(file) > 0 && <span className="text-muted-foreground"> ({cited(file)})</span>}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
      <div className="min-h-0 flex-1">
        {content.isError ? (
          <Empty className="h-full">
            <EmptyHeader>
              <EmptyTitle>Impossibile caricare il file</EmptyTitle>
              <EmptyDescription>{content.error.message}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : content.data === undefined ? (
          <Skeleton className="h-full w-full rounded-none" />
        ) : (
          <CodeViewer
            path={content.data.path}
            language={content.data.language}
            content={content.data.content}
            secretLines={content.data.secrets.map((secret) => secret.line)}
            highlights={references.filter((reference) => reference.path === path)}
            focus={focus}
          />
        )}
      </div>
    </div>
  )
}
