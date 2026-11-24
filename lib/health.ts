// What /api/health reports. It is public (a host's health check can't sign
// in), so it says only whether things work, never why in detail: no variable
// names, no connection details, nothing about any user. The details go to the
// server log at start-up and to `npm run check:env`.
import { sql } from "drizzle-orm"

import { checkEnvironment } from "@/lib/env"

export type Health = {
  // ok: everything works. degraded: the app is up but something optional is
  // off or required settings are missing. down: the database can't be reached.
  status: "ok" | "degraded" | "down"
  database: "ok" | "error"
  // Whether each optional feature is switched on (not whether the service
  // behind it is up).
  features: {
    replies: boolean
    sandboxes: boolean
    errorTracking: boolean
  }
  // How many required settings are missing. Names are in the log.
  missingRequired: number
}

// A database check that is cheap but not free, on a public URL. The answer is
// kept for a few seconds so a flood of requests costs one query, not many.
const CACHE_MS = 10_000
const DATABASE_TIMEOUT_MS = 4_000
let cached: { at: number; ok: boolean } | null = null
let inFlight: Promise<boolean> | null = null

async function queryDatabase(): Promise<boolean> {
  try {
    // Imported here so a missing DATABASE_URL is reported as "error" instead
    // of failing the whole route when the module loads.
    const { db } = await import("@/lib/db")
    await Promise.race([
      db.execute(sql`select 1`),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timed out")), DATABASE_TIMEOUT_MS)
      ),
    ])
    return true
  } catch {
    return false
  }
}

async function databaseIsUp(now: number): Promise<boolean> {
  if (cached && now - cached.at < CACHE_MS) {
    return cached.ok
  }
  // Callers that arrive while a check is running share it.
  inFlight ??= queryDatabase().finally(() => {
    inFlight = null
  })
  const ok = await inFlight
  cached = { at: Date.now(), ok }
  return ok
}

// For tests: forget the last answer.
export function resetHealthCache() {
  cached = null
  inFlight = null
}

export async function getHealth(
  env: Record<string, string | undefined> = process.env
): Promise<Health> {
  const database = (await databaseIsUp(Date.now())) ? "ok" : "error"
  const report = checkEnvironment("web", env)

  const features = {
    replies: !report.notConfigured.some((item) => item.feature === "replies"),
    sandboxes: !report.notConfigured.some((item) => item.feature === "sandboxes"),
    errorTracking: !report.notConfigured.some(
      (item) => item.feature === "error tracking"
    ),
  }

  const status =
    database === "error"
      ? "down"
      : report.missingRequired.length > 0
        ? "degraded"
        : "ok"

  return {
    status,
    database,
    features,
    missingRequired: report.missingRequired.length,
  }
}
