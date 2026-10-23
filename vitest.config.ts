import { loadEnv } from "vite"
import { defineConfig } from "vitest/config"

// Tests read TEST_DATABASE_URL and friends from the root .env (CI sets them directly).
const env = loadEnv("test", process.cwd(), "")

export default defineConfig({
  test: {
    env,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
          exclude: ["**/*.integration.test.ts"]
        }
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["packages/*/test/**/*.integration.test.ts", "apps/*/test/**/*.integration.test.ts"],
          // Integration tests share one database: run their files one at a time.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000
        }
      }
    ]
  }
})
