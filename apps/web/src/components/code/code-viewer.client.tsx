import Editor from "@monaco-editor/react"
import { useTheme } from "next-themes"
import { useEffect, useState } from "react"
import { monaco } from "./monaco.client"

/** Our language ids follow Monaco's; these are the exceptions. */
const monacoLanguage = (language: string): string => {
  switch (language) {
    case "vue":
    case "svelte":
      return "html"
    case "toml":
    case "makefile":
    case "groovy":
      return "plaintext"
    default:
      return language
  }
}

/** A line range to scroll to and highlight; `key` re-triggers the same range. */
export interface CodeFocus {
  readonly startLine: number
  readonly endLine: number
  readonly key: number
}

export interface CodeViewerProps {
  readonly path: string
  readonly language: string
  readonly content: string
  /** 1-based lines containing masked secrets; highlighted in the gutter. */
  readonly secretLines: ReadonlyArray<number>
  readonly focus?: CodeFocus | undefined
}

export default function CodeViewer({ path, language, content, secretLines, focus }: CodeViewerProps) {
  const { resolvedTheme } = useTheme()
  // Kept in state (not a ref) so that the effects below run once the editor is mounted.
  const [editor, setEditor] = useState<monaco.editor.IStandaloneCodeEditor | null>(null)

  useEffect(() => {
    if (editor === null) return
    const decorations = editor.createDecorationsCollection(
      secretLines.map((line) => ({
        range: new monaco.Range(line, 1, line, 1),
        options: {
          isWholeLine: true,
          className: "code-viewer-secret-line",
          linesDecorationsClassName: "code-viewer-secret-gutter",
          hoverMessage: { value: "Credenziale mascherata prima del salvataggio" }
        }
      }))
    )
    return () => decorations.clear()
  }, [editor, secretLines, content])

  useEffect(() => {
    if (editor === null || focus === undefined) return
    const range = new monaco.Range(focus.startLine, 1, focus.endLine, 1)
    editor.revealRangeNearTop(range)
    const decorations = editor.createDecorationsCollection([
      {
        range,
        options: {
          isWholeLine: true,
          className: "code-viewer-focus-line",
          linesDecorationsClassName: "code-viewer-focus-gutter"
        }
      }
    ])
    return () => decorations.clear()
  }, [editor, focus, content])

  return (
    <Editor
      path={path}
      value={content}
      language={monacoLanguage(language)}
      theme={resolvedTheme === "dark" ? "vs-dark" : "vs"}
      onMount={setEditor}
      loading={null}
      options={{
        readOnly: true,
        domReadOnly: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        fontSize: 13,
        renderLineHighlight: "none",
        stickyScroll: { enabled: false }
      }}
    />
  )
}
