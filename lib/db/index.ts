import { neon } from "@neondatabase/serverless"
import { drizzle } from "drizzle-orm/neon-http"

import * as schema from "./schema"

const connectionString = process.env.DATABASE_URL

if (!connectionString) {
  throw new Error(
    'DATABASE_URL is not set. Add it to .env.local (or the host\'s variables); see "Environment variables" in the README.'
  )
}

// Neon's HTTP driver sends one stateless request per query, so there is no
// connection pool to manage and it works on any host.
export const db = drizzle({ client: neon(connectionString), schema })
