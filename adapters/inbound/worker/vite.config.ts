import { defineConfig } from "vite"
import { treeSitterGrammars } from "../../../scripts/vite-plugin-grammars.mjs"
import { thirdPartyLicenses } from "../../../scripts/vite-plugin-third-party.mjs"

/**
 * Bundles the worker and the migration command into standalone Node ESM
 * files, dependencies included: the runtime image needs no node_modules.
 */
export default defineConfig({
  plugins: [thirdPartyLicenses(), treeSitterGrammars()],
  build: {
    ssr: true,
    target: "node24",
    outDir: "dist",
    rolldownOptions: {
      input: { main: "src/main.ts", migrate: "src/migrate.ts" },
      output: { format: "es", entryFileNames: "[name].js" }
    }
  },
  ssr: { noExternal: true }
})
