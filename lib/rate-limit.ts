import { RATE_LIMIT_MAX_MESSAGES, RATE_LIMIT_WINDOW_MS } from "@/lib/ai"

// A sliding window per user, kept in memory. That's enough for one server; with
// several instances each has its own count, so the real limit is higher. Move
// this to a shared store (Redis, Postgres) if that starts to matter.
const hits = new Map<string, number[]>()

export function checkRateLimit(
  userId: string,
  now = Date.now()
): { ok: true } | { ok: false; retryAfterSeconds: number } {
  const recent = (hits.get(userId) ?? []).filter(
    (time) => now - time < RATE_LIMIT_WINDOW_MS
  )

  if (recent.length >= RATE_LIMIT_MAX_MESSAGES) {
    hits.set(userId, recent)
    const oldest = recent[0]
    return {
      ok: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((oldest + RATE_LIMIT_WINDOW_MS - now) / 1000)
      ),
    }
  }

  recent.push(now)
  hits.set(userId, recent)

  // Forget users who have gone quiet so the map doesn't grow forever.
  if (hits.size > 1000) {
    for (const [id, times] of hits) {
      if (times.every((time) => now - time >= RATE_LIMIT_WINDOW_MS)) {
        hits.delete(id)
      }
    }
  }

  return { ok: true }
}
