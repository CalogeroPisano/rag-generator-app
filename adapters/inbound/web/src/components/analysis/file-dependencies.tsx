import { ArrowDownLeftIcon, ArrowUpRightIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { type DependencyData, type FileAnalysisData, targetKindLabels } from "./labels"

function TargetBadge({ dependency }: { dependency: DependencyData }) {
  const { label, description } = targetKindLabels[dependency.targetKind]
  const variant =
    dependency.targetKind === "unresolved" ? "warning" : dependency.targetKind === "external" ? "secondary" : "info"
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant={variant} className="shrink-0">
          {label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>{description}</TooltipContent>
    </Tooltip>
  )
}

/** Outgoing imports (with their resolved target) and incoming references of a file. */
export function FileDependencies({
  analysis,
  onOpenFile
}: {
  analysis: FileAnalysisData
  onOpenFile: (path: string) => void
}) {
  return (
    <div className="flex flex-col gap-6 p-3 text-sm">
      <section className="flex flex-col gap-2">
        <h3 className="flex items-center gap-1.5 font-medium">
          <ArrowUpRightIcon className="size-4" /> Importa ({analysis.imports.length})
        </h3>
        {analysis.imports.length === 0 ? (
          <p className="text-muted-foreground">Nessun import.</p>
        ) : (
          <ul className="flex flex-col divide-y rounded-md border">
            {analysis.imports.map((dependency) => (
              <li key={`${dependency.line}:${dependency.specifier}`} className="flex items-center gap-2 px-3 py-1.5">
                <TargetBadge dependency={dependency} />
                <span className="min-w-0 truncate font-mono text-xs" title={dependency.specifier}>
                  {dependency.specifier}
                </span>
                {dependency.targetKind === "file" && dependency.target !== null ? (
                  <button
                    type="button"
                    onClick={() => onOpenFile(dependency.target!)}
                    className="ml-auto min-w-0 truncate text-xs text-info hover:underline"
                    title={dependency.target}
                  >
                    {dependency.target}
                  </button>
                ) : (
                  <span className="ml-auto min-w-0 truncate text-xs text-muted-foreground">
                    {dependency.externalName ?? dependency.target ?? ""}
                  </span>
                )}
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">r. {dependency.line}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="flex items-center gap-1.5 font-medium">
          <ArrowDownLeftIcon className="size-4" /> Usato da ({analysis.importedBy.length})
        </h3>
        {analysis.importedBy.length === 0 ? (
          <p className="text-muted-foreground">Nessun file del progetto importa questo file.</p>
        ) : (
          <ul className="flex flex-col divide-y rounded-md border">
            {analysis.importedBy.map((dependent) => (
              <li key={dependent.path} className="flex items-center gap-2 px-3 py-1.5">
                <button
                  type="button"
                  onClick={() => onOpenFile(dependent.path)}
                  className="min-w-0 truncate text-left text-xs text-info hover:underline"
                >
                  {dependent.path}
                </button>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">r. {dependent.line}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
