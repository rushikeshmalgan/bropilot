import { config } from "dotenv"
import { defineConfig } from "drizzle-kit"

// drizzle-kit runs outside Next.js, so it does not load .env.local on its own.
config({ path: ".env.local", quiet: true })

// Schema changes must use the direct connection, not the pooled one.
const url = process.env.DATABASE_URL_UNPOOLED

if (!url) {
  throw new Error(
    "DATABASE_URL_UNPOOLED is not set. Run `npx neon@latest link` to pull it into .env.local."
  )
}

export default defineConfig({
  schema: "./lib/db/schema.ts",
  dialect: "postgresql",
  dbCredentials: { url },
})
