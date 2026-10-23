import tailwindcss from "@tailwindcss/vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import { defineConfig, loadEnv } from "vite"
import { thirdPartyLicenses } from "../../scripts/vite-plugin-third-party.mjs"

export default defineConfig(({ command, mode }) => {
  // In development, server code reads its configuration from the root .env
  // (in production the environment comes from Docker Compose).
  if (command === "serve") Object.assign(process.env, loadEnv(mode, "../..", ""), process.env)

  return {
    resolve: { tsconfigPaths: true },
    plugins: [tailwindcss(), tanstackStart(), viteReact(), thirdPartyLicenses()],
    ssr: {
      // Build: bundle everything, so the runtime image has no node_modules.
      // Dev: only compile the workspace packages (TypeScript sources).
      noExternal: command === "build" ? true : [/^@code-to-rag\//]
    }
  }
})
