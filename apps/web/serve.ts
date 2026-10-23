/**
 * Production entry point: serves the client assets and hands every other
 * request to the TanStack Start server build. Bundled with its dependencies
 * (`vite.serve.config.ts`), so the image needs no node_modules.
 */
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { serve } from "srvx/node"
import { staticMiddleware } from "srvx/static"

const here = path.dirname(fileURLToPath(import.meta.url))
const serverEntry = pathToFileURL(path.join(here, "server/server.js")).href
const app = (await import(/* @vite-ignore */ serverEntry)) as {
  default: { fetch: (request: Request) => Promise<Response> }
}

const maxArchiveMb = Number(process.env["ACQUISITION_MAX_ARCHIVE_MB"] ?? "200")

serve({
  fetch: (request) => app.default.fetch(request),
  port: Number(process.env["PORT"] ?? "3000"),
  hostname: process.env["HOST"] ?? "0.0.0.0",
  middleware: [staticMiddleware({ dir: path.join(here, "client") })],
  // Uploads are also limited while streaming; this is the outer guard.
  maxRequestBodySize: (maxArchiveMb + 1) * 1024 * 1024,
  trustProxy: process.env["TRUST_PROXY"] === "true",
  gracefulShutdown: true
})
