import { Fragment, type ReactNode } from "react"
import { cn } from "@/lib/utils"

const CITATION = /(\[\d+(?:\s*,\s*\d+)*\])/

/** Inline text with `[n]` markers turned into citation buttons (numbers outside the sources stay as text). */
function Inline({ text, sourceCount, onCite }: { text: string; sourceCount: number; onCite: (n: number) => void }) {
  return text.split(CITATION).map((part, i) => {
    if (i % 2 === 0) return <Fragment key={i}>{part}</Fragment>
    const numbers = part
      .slice(1, -1)
      .split(",")
      .map((n) => Number(n.trim()))
    if (numbers.some((n) => n < 1 || n > sourceCount)) return <Fragment key={i}>{part}</Fragment>
    return (
      <Fragment key={i}>
        {numbers.map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => onCite(n)}
            className="mx-0.5 inline-flex h-4 min-w-4 -translate-y-0.5 items-center justify-center rounded bg-primary/10 px-1 text-[10px] font-semibold text-primary hover:bg-primary/20"
            aria-label={`Fonte ${n}`}
          >
            {n}
          </button>
        ))}
      </Fragment>
    )
  })
}

/**
 * Plain-text answer of the chat model: paragraphs separated by blank lines,
 * `- ` lines as lists, citations as buttons. No Markdown/HTML rendering.
 */
export function AnswerText({
  text,
  sourceCount,
  onCite,
  className
}: {
  text: string
  sourceCount: number
  onCite: (n: number) => void
  className?: string
}) {
  const blocks: Array<ReactNode> = []
  text
    .trim()
    .split(/\n{2,}/)
    .forEach((block, b) => {
      const lines = block.split("\n")
      let list: Array<string> = []
      const flush = (key: string) => {
        if (list.length === 0) return
        blocks.push(
          <ul key={key} className="list-disc space-y-1 pl-5">
            {list.map((item, i) => (
              <li key={i}>
                <Inline text={item} sourceCount={sourceCount} onCite={onCite} />
              </li>
            ))}
          </ul>
        )
        list = []
      }
      lines.forEach((line, l) => {
        const item = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line)
        if (item !== null) {
          list.push(item[1] ?? "")
          return
        }
        flush(`${b}-${l}-list`)
        if (line.trim() !== "") {
          blocks.push(
            <p key={`${b}-${l}`}>
              <Inline text={line} sourceCount={sourceCount} onCite={onCite} />
            </p>
          )
        }
      })
      flush(`${b}-end-list`)
    })
  return <div className={cn("flex flex-col gap-2 text-sm leading-relaxed", className)}>{blocks}</div>
}
