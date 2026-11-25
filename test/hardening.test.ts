import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

import { sql } from "drizzle-orm"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { GET as getHealthRoute } from "@/app/api/health/route"
import { db } from "@/lib/db"
import {
  ENV_VARIABLES,
  FRAMEWORK_VARIABLES,
  checkEnvironment,
  describeEnvironment,
  isUsableSecret,
  type EnvScope,
} from "@/lib/env"
import { getHealth, resetHealthCache } from "@/lib/health"
import {
  ENFORCED_CSP,
  clerkHostFromKey,
  reportOnlyCsp,
  securityHeaders,
} from "@/lib/security-headers"
import nextConfig from "@/next.config"

const ROOT = path.resolve(__dirname, "..")

// Every source file the app is made of (not tests, not build output).
function sourceFiles(dir: string, found: string[] = []) {
  for (const name of readdirSync(dir)) {
    // Not ours: dependencies, build output, hidden folders (.next, .claude and
    // the AI assistants' skill folders), the tests themselves.
    if (name.startsWith(".") || ["node_modules", "test", "public"].includes(name)) {
      continue
    }
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) {
      sourceFiles(full, found)
    } else if (/\.(ts|tsx|mjs)$/.test(name) && !name.endsWith(".d.ts")) {
      found.push(full)
    }
  }
  return found
}

describe("the list of environment variables", () => {
  it("names every variable the code reads", () => {
    const known = new Set([
      ...ENV_VARIABLES.map((variable) => variable.name),
      ...FRAMEWORK_VARIABLES,
    ])
    const unknown: string[] = []

    for (const file of sourceFiles(ROOT)) {
      const text = readFileSync(file, "utf8")
      const names = [
        ...text.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g),
        ...text.matchAll(/usableSecret\("([A-Z][A-Z0-9_]*)"\)/g),
      ].map((match) => match[1])

      for (const name of names) {
        if (!known.has(name)) {
          unknown.push(`${path.relative(ROOT, file)}: ${name}`)
        }
      }
    }

    expect(unknown).toEqual([])
  })

  it("is mirrored in the README, so the docs can't fall behind", () => {
    const readme = readFileSync(path.join(ROOT, "README.md"), "utf8")
    const missing = ENV_VARIABLES.filter(
      (variable) => !readme.includes(`\`${variable.name}\``)
    ).map((variable) => variable.name)
    expect(missing).toEqual([])
  })

  it("has no duplicates, and says where each variable is needed", () => {
    const names = ENV_VARIABLES.map((variable) => variable.name)
    expect(new Set(names).size).toBe(names.length)
    for (const variable of ENV_VARIABLES) {
      expect(variable.scopes.length, variable.name).toBeGreaterThan(0)
      expect(variable.purpose, variable.name).not.toBe("")
      if (variable.kind === "optional" && variable.feature) {
        expect(variable.without, variable.name).toBeTruthy()
      }
    }
  })
})

describe("checking the environment", () => {
  const complete = {
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_abc",
    CLERK_SECRET_KEY: "sk_test_abc",
    DATABASE_URL: "postgres://x",
    GOOGLE_GENERATIVE_AI_API_KEY: "AIza-abc",
  }

  it("lists each missing required variable by name, for each place the app runs", () => {
    const names = (scope: EnvScope, env: Record<string, string | undefined>) =>
      checkEnvironment(scope, env).missingRequired

    expect(names("web", {})).toEqual([
      "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
      "CLERK_SECRET_KEY",
      "DATABASE_URL",
    ])
    // The model is called from the worker, so only the worker needs its key.
    expect(names("worker", {})).toEqual([
      "DATABASE_URL",
      "GOOGLE_GENERATIVE_AI_API_KEY",
    ])
    expect(names("web", complete)).toEqual([])
    expect(names("worker", complete)).toEqual([])
    expect(names("web", { ...complete, DATABASE_URL: "   " })).toEqual([
      "DATABASE_URL",
    ])
  })

  it("treats optional services as switched off, not as errors", () => {
    const report = checkEnvironment("web", complete)
    expect(report.missingRequired).toEqual([])
    expect(report.notConfigured.map((item) => item.feature).sort()).toEqual([
      "error tracking",
      "replies",
      "sandboxes",
    ])
  })

  it("accepts only a usable Trigger.dev secret key", () => {
    const features = (key: string) =>
      checkEnvironment("web", { ...complete, TRIGGER_SECRET_KEY: key })
        .notConfigured.map((item) => item.feature)

    expect(features("tr_dev_abcdef123456")).not.toContain("replies")
    expect(features("tr_prod_abcdef123456")).not.toContain("replies")
    // A personal access token, a masked copy, a blank and a wrong kind of key.
    expect(features("tr_pat_abcdef123456")).toContain("replies")
    expect(features("tr_dev_ab••••")).toContain("replies")
    expect(features("   ")).toContain("replies")
    expect(features("sk_live_abcdef")).toContain("replies")
  })

  it("turns features on with their keys", () => {
    const report = checkEnvironment("web", {
      ...complete,
      TRIGGER_SECRET_KEY: "tr_dev_abcdef123456",
      DAYTONA_API_KEY: "dtn_abcdef123456",
      SENTRY_DSN: "https://k@o0.ingest.example/1",
    })
    expect(report.notConfigured).toEqual([])
  })

  it("never puts a value in what it says", () => {
    const secret = "SUPERSECRETVALUE0123456789"
    const lines = describeEnvironment("web", {
      DATABASE_URL: secret,
      CLERK_SECRET_KEY: secret,
      DAYTONA_API_KEY: "has a space " + secret,
    }).join("\n")
    expect(lines).not.toContain(secret)
    expect(lines).toContain("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY")
    expect(lines).toContain("sandboxes is off")
    expect(isUsableSecret(secret)).toBe(true)
    expect(isUsableSecret("has a space")).toBe(false)
  })
})

describe("/api/health", () => {
  // The first query of a test file opens the connection to Neon, which can take
  // longer than the health check allows when the machine is busy. That is the
  // check working, not failing, so the connection is opened first.
  beforeAll(async () => {
    await db.execute(sql`select 1`)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    resetHealthCache()
  })

  it("answers ok when the database answers, and says nothing about people or settings", async () => {
    const response = await getHealthRoute()
    expect(response.status).toBe(200)
    expect(response.headers.get("Cache-Control")).toBe("no-store")

    const text = await response.text()
    const body = JSON.parse(text) as Awaited<ReturnType<typeof getHealth>>
    expect(body.database).toBe("ok")
    expect(["ok", "degraded"]).toContain(body.status)
    expect(Object.keys(body).sort()).toEqual([
      "database",
      "features",
      "missingRequired",
      "status",
    ])

    // No variable names, no connection details, no user data.
    expect(text).not.toMatch(/DATABASE_URL|CLERK|postgres|neon\.tech|user_|test_/i)
    for (const variable of ENV_VARIABLES) {
      const value = process.env[variable.name]
      if (value && value.length > 8) {
        expect(text).not.toContain(value)
      }
    }
  })

  it("answers 503 when the database can't be reached", async () => {
    vi.spyOn(db, "execute").mockRejectedValue(new Error("connection refused"))
    const response = await getHealthRoute()
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      status: "down",
      database: "error",
    })
  })

  it("asks the database once for a burst of requests", async () => {
    const spy = vi.spyOn(db, "execute")
    await Promise.all(Array.from({ length: 20 }, () => getHealthRoute()))
    await getHealthRoute()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it("says degraded, and how many settings are missing, without naming them", async () => {
    const health = await getHealth({})
    expect(health.status).toBe("degraded")
    expect(health.missingRequired).toBe(3)
    expect(health.features).toEqual({
      replies: false,
      sandboxes: false,
      errorTracking: false,
    })
  })

  it("gives up on a database that doesn't answer, after a few seconds", async () => {
    vi.spyOn(db, "execute").mockImplementation(
      () => new Promise(() => {}) as never
    )
    const started = Date.now()
    expect(await getHealth()).toMatchObject({ status: "down", database: "error" })
    // Real time, on purpose: the check must not hang a health request.
    expect(Date.now() - started).toBeLessThan(10_000)
  })
})

describe("security headers", () => {
  const options = {
    production: true,
    clerkHost: "example-12.clerk.accounts.dev",
    sentryDsn: "https://key@o123.ingest.sentry.io/456",
  }
  const header = (name: string, production = true) =>
    securityHeaders({ ...options, production }).find((h) => h.key === name)?.value

  it("sends the basic set on every response", () => {
    expect(header("X-Content-Type-Options")).toBe("nosniff")
    expect(header("X-Frame-Options")).toBe("DENY")
    expect(header("Referrer-Policy")).toBe("strict-origin-when-cross-origin")
    expect(header("Permissions-Policy")).toContain("camera=()")
    expect(header("Permissions-Policy")).toContain("microphone=()")
    expect(header("Strict-Transport-Security")).toMatch(/max-age=\d+/)
  })

  it("sends HSTS only in production", () => {
    expect(header("Strict-Transport-Security", false)).toBeUndefined()
  })

  it("enforces a policy that can't block anything the app loads", () => {
    expect(header("Content-Security-Policy")).toBe(ENFORCED_CSP)
    expect(ENFORCED_CSP).toContain("frame-ancestors 'none'")
    expect(ENFORCED_CSP).toContain("object-src 'none'")
    expect(ENFORCED_CSP).not.toMatch(/script-src|default-src|connect-src|frame-src/)
  })

  it("reports, without blocking, a full policy that names the hosts the app uses", () => {
    const policy = header("Content-Security-Policy-Report-Only") ?? ""
    expect(policy).toContain("default-src 'self'")
    expect(policy).toContain("https://example-12.clerk.accounts.dev")
    expect(policy).toContain("https://o123.ingest.sentry.io")
    expect(policy).toContain("wss://api.trigger.dev")
    expect(policy).toContain("frame-ancestors 'none'")
    // 'unsafe-eval' is for the development server only.
    expect(policy).not.toContain("'unsafe-eval'")
    expect(reportOnlyCsp({ ...options, production: false })).toContain("'unsafe-eval'")
  })

  it("copes with no Clerk host and no Sentry", () => {
    const policy = reportOnlyCsp({ production: true })
    expect(policy).not.toContain("undefined")
    expect(policy).not.toContain("https://null")
  })

  it("finds Clerk's host in the publishable key, and nothing else", () => {
    const key = (host: string) => `pk_test_${btoa(`${host}$`)}`
    expect(clerkHostFromKey(key("example-12.clerk.accounts.dev"))).toBe(
      "example-12.clerk.accounts.dev"
    )
    expect(clerkHostFromKey(key("clerk.example.com"))).toBe("clerk.example.com")
    // Anything that isn't a plain host name is ignored, so a bad value can't
    // add a source to the policy.
    expect(clerkHostFromKey(key("evil.com; script-src *"))).toBeNull()
    expect(clerkHostFromKey("pk_test_!!!")).toBeNull()
    expect(clerkHostFromKey("nonsense")).toBeNull()
    expect(clerkHostFromKey(undefined)).toBeNull()
  })

  it("is what the app's configuration sends, for every path, without the framework header", async () => {
    expect(nextConfig.poweredByHeader).toBe(false)
    const rules = (await nextConfig.headers?.()) ?? []
    expect(rules).toHaveLength(1)
    expect(rules[0].source).toBe("/:path*")
    const keys = rules[0].headers.map((h) => h.key)
    for (const required of [
      "X-Content-Type-Options",
      "X-Frame-Options",
      "Referrer-Policy",
      "Permissions-Policy",
      "Content-Security-Policy",
      "Content-Security-Policy-Report-Only",
    ]) {
      expect(keys).toContain(required)
    }
  })
})
