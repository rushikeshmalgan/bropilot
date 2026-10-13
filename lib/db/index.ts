import { neon } from "@neondatabase/serverless"
import { drizzle } from "drizzle-orm/neon-http"

import * as schema from "./schema"

const connectionString = process.env.DATABASE_URL

if (!connectionString) {
  throw new Error("DATABASE_URL is not set")
}

// Neon's HTTP driver sends one stateless request per query, so there is no
// connection pool to manage and it works on any host.
export const db = drizzle({ client: neon(connectionString), schema })
