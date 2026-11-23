// Where the app gets its outside services from. Each one is used only when its
// environment variable holds a usable value; otherwise the getter returns null
// and the feature shows a "not configured" state instead of failing.
import { daytonaProvider } from "@/lib/providers/daytona"
import { firecrawlProvider, type WebProvider } from "@/lib/providers/firecrawl"
import { triggerRunQueue, type RunQueue } from "@/lib/providers/run-queue"
import type { SandboxProvider } from "@/lib/providers/sandbox"

type Providers = {
  runQueue: RunQueue | null
  web: WebProvider | null
  sandbox: SandboxProvider | null
}

// Tests replace providers with in-memory fakes through this. The app itself
// never calls overrideProviders.
let overrides: Partial<Providers> = {}

export function overrideProviders(next: Partial<Providers>) {
  overrides = { ...overrides, ...next }
}

export function resetProviderOverrides() {
  overrides = {}
}

// A secret as it would be sent in a header: printable ASCII with no spaces.
// A value copied from a masked display ("tr_dev_ab••••") isn't one, and using
// it would only fail later with a confusing error, so it counts as not set.
export function usableSecret(name: string): string | null {
  const value = process.env[name]?.trim()
  return value && /^[\x21-\x7e]+$/.test(value) ? value : null
}

// Trigger.dev secret keys start with tr_dev_, tr_prod_ and so on. A personal
// access token (tr_pat_) is for the CLI and can't queue runs.
export function hasTriggerKey() {
  const key = usableSecret("TRIGGER_SECRET_KEY")
  return key !== null && key.startsWith("tr_") && !key.startsWith("tr_pat_")
}

export function getRunQueue(): RunQueue | null {
  if ("runQueue" in overrides) {
    return overrides.runQueue ?? null
  }

  return hasTriggerKey() ? triggerRunQueue : null
}

// Web search and page reading (Firecrawl), or null without FIRECRAWL_API_KEY.
export function getWebProvider(): WebProvider | null {
  if ("web" in overrides) {
    return overrides.web ?? null
  }

  const key = usableSecret("FIRECRAWL_API_KEY")
  return key ? firecrawlProvider(key) : null
}

// Sandboxes (Daytona), or null without DAYTONA_API_KEY.
let daytona: { key: string; provider: SandboxProvider } | null = null

export function getSandboxProvider(): SandboxProvider | null {
  if ("sandbox" in overrides) {
    return overrides.sandbox ?? null
  }

  const key = usableSecret("DAYTONA_API_KEY")
  if (!key) {
    return null
  }

  // An optional snapshot to make sandboxes from (for a desktop image). Only
  // plain snapshot names are accepted.
  const snapshot = process.env.DAYTONA_SNAPSHOT?.trim()
  const validSnapshot =
    snapshot && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(snapshot)
      ? snapshot
      : undefined

  // One provider per key and snapshot, so its client is made once.
  const identity = `${key}|${validSnapshot ?? ""}`
  if (daytona?.key !== identity) {
    daytona = {
      key: identity,
      provider: daytonaProvider(key, { snapshot: validSnapshot }),
    }
  }
  return daytona.provider
}
