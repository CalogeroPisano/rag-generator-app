import { defineConfig } from "vite"
import { thirdPartyLicenses } from "../../scripts/vite-plugin-third-party.mjs"

/** Builds `serve.ts` (the Node HTTP entry point) next to the app build in `dist/`. */
export default defineConfig({
  plugins: [thirdPartyLicenses({ manifestName: "serve" })],
  publicDir: false,
  build: {
    ssr: true,
    target: "node24",
    outDir: "dist",
    emptyOutDir: false,
    rolldownOptions: {
      input: { serve: "serve.ts" },
      output: { format: "es", entryFileNames: "[name].js" }
    }
  },
  ssr: { noExternal: true }
})
