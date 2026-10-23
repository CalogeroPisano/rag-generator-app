import { useEffect, useState } from "react"
import { isTerminal, type JobEventWire, type JobStateWire } from "@/lib/job-stream"

export interface JobStream {
  readonly job: JobStateWire | undefined
  readonly events: ReadonlyArray<JobEventWire>
  readonly connected: boolean
}

/**
 * Follows a job through `/api/jobs/$jobId/events`. The browser's EventSource
 * reconnects by itself (resuming from the last event id); the stream is
 * closed here once the job reaches a terminal state, otherwise EventSource
 * would keep reconnecting to a finished stream.
 */
interface StreamState extends JobStream {
  readonly jobId: string
}

/**
 * `streamKey` forces a new connection for the same job (e.g. after a manual
 * retry the job id is unchanged but the previous stream was closed).
 */
export function useJobStream(
  jobId: string | undefined,
  streamKey: string,
  onTerminal?: (job: JobStateWire) => void
): JobStream {
  // State is tagged with its job id: switching job shows an empty stream
  // without resetting state inside the effect.
  const [state, setState] = useState<StreamState | undefined>()

  useEffect(() => {
    if (jobId === undefined) return
    const update = (change: (current: JobStream) => Partial<JobStream>) =>
      setState((previous) => {
        const current: JobStream =
          previous?.jobId === jobId ? previous : { job: undefined, events: [], connected: false }
        return { ...current, ...change(current), jobId }
      })
    const source = new EventSource(`/api/jobs/${jobId}/events`)
    source.onopen = () => update(() => ({ connected: true }))
    source.onerror = () => update(() => ({ connected: false }))
    source.addEventListener("job-event", (message) => {
      const event = JSON.parse((message as MessageEvent<string>).data) as JobEventWire
      update(({ events }) => ({ events: events.some((e) => e.id === event.id) ? events : [...events, event] }))
    })
    source.addEventListener("job", (message) => {
      const job = JSON.parse((message as MessageEvent<string>).data) as JobStateWire
      update(() => ({ job }))
      if (isTerminal(job.status)) {
        source.close()
        update(() => ({ connected: false }))
        onTerminal?.(job)
      }
    })
    source.addEventListener("not-found", () => source.close())
    return () => source.close()
    // onTerminal is intentionally not a dependency: reconnecting on every render would be wrong.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, streamKey])

  return state !== undefined && state.jobId === jobId ? state : { job: undefined, events: [], connected: false }
}
