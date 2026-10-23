/**
 * Monaco setup, browser only. Monaco is served from our own bundle (never from
 * a CDN: the product runs on premise, possibly offline). Only the editor core,
 * a few read-only features and Monarch syntax highlighting are loaded: no
 * language services, so the editor worker is the only web worker needed.
 */
import { loader } from "@monaco-editor/react"
import * as monaco from "monaco-editor/editor/editor.api.js"
import "monaco-editor/languages/definitions/register.all.js"
import "monaco-editor/features/codicon/register.js"
import "monaco-editor/features/bracketMatching/register.js"
import "monaco-editor/features/clipboard/register.js"
import "monaco-editor/features/contextmenu/register.js"
import "monaco-editor/features/find/register.js"
import "monaco-editor/features/folding/register.js"
import "monaco-editor/features/hover/register.js"
import "monaco-editor/features/readOnlyMessage/register.js"
import "monaco-editor/features/wordHighlighter/register.js"
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker"

self.MonacoEnvironment = { getWorker: () => new EditorWorker() }
loader.config({ monaco })

export { monaco }
