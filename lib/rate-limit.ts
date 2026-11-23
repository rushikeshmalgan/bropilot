import { RATE_LIMIT_MAX_MESSAGES, RATE_LIMIT_WINDOW_MS } from "@/lib/ai"

// A sliding window per user, kept in memory. That's enough for one server; with
// several instances each has its own count, so the real limit is higher. Move
// this to a shared store (Redis, Postgres) if that starts to matter.
const hits = new Map<string, number[]>()

export type LimitResult = { ok: true } | { ok: false; retryAfterSeconds: number }

// Counts one hit for `key` and says whether it is within `max` hits per
// `windowMs`. `scope` keeps different limits (messages, screen addresses) from
// sharing a count.
export function checkLimit(
  scope: string,
  key: string,
  max: number,
  windowMs: number,
  now = Date.now()
): LimitResult {
  const id = `${scope}:${key}`
  const recent = (hits.get(id) ?? []).filter((time) => now - time < windowMs)

  if (recent.length >= max) {
    hits.set(id, recent)
    const oldest = recent[0]
    return {
      ok: false,
      retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)),
    }
  }

  recent.push(now)
  hits.set(id, recent)

  // Forget keys that have gone quiet so the map doesn't grow forever.
  if (hits.size > 1000) {
    for (const [name, times] of hits) {
      if (times.every((time) => now - time >= windowMs)) {
        hits.delete(name)
      }
    }
  }

  return { ok: true }
}

// Messages a user may send.
export function checkRateLimit(userId: string, now = Date.now()): LimitResult {
  return checkLimit(
    "messages",
    userId,
    RATE_LIMIT_MAX_MESSAGES,
    RATE_LIMIT_WINDOW_MS,
    now
  )
}
