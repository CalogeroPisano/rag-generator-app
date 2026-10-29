import { ClientOnly } from "@tanstack/react-router"
import { lazy, Suspense } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import type { CodeViewerProps } from "./code-viewer.client"

// Monaco touches `window` on import: load it only in the browser.
const LazyCodeViewer = lazy(() => import("./code-viewer.client"))

export function CodeViewer(props: CodeViewerProps) {
  const fallback = <Skeleton className="h-full w-full rounded-none" />
  return (
    <ClientOnly fallback={fallback}>
      <Suspense fallback={fallback}>
        <LazyCodeViewer {...props} />
      </Suspense>
    </ClientOnly>
  )
}
