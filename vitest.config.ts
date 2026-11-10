import path from "node:path"
import { config } from "dotenv"
import { defineConfig } from "vitest/config"

// Tests talk to the dev database, so they need the same variables as the app.
config({ path: ".env.local", quiet: true })

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname) },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    // Every query is an HTTP round trip to Neon, so tests are not instant.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
