// Where the app gets its outside services from. Each one is used only when its
// environment variable holds a usable value; otherwise the getter returns null
// and the feature shows a "not configured" state instead of failing.
import { triggerRunQueue, type RunQueue } from "@/lib/providers/run-queue"

type Providers = {
  runQueue: RunQueue | null
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
