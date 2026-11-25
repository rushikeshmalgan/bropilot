// Text that is safe to store and to send on.
//
// Postgres refuses the NUL character (U+0000) in text and in JSON, and some
// services refuse half of a surrogate pair (what is left when an emoji is cut
// in the middle). Command output, page text and model output can contain
// either, and one such character would make a whole reply impossible to save.

// The text without NUL characters, and with any lone half of an emoji turned
// into the replacement character.
export function cleanText(value: string): string {
  return value.replaceAll("\u0000", "").toWellFormed()
}

// The first `max` characters, without ending in the first half of an emoji.
export function safeSlice(value: string, max: number): string {
  if (value.length <= max) {
    return value
  }
  let end = max
  const last = value.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) {
    end -= 1
  }
  return value.slice(0, end)
}

const MAX_DEPTH = 12

// A copy of anything that will be saved as JSON, with every string (and every
// key) cleaned. Values that JSON can't hold are dropped.
export function cleanDeep(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return cleanText(value)
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value
  }
  if (depth >= MAX_DEPTH) {
    return null
  }
  if (Array.isArray(value)) {
    return value.map((item) => cleanDeep(item, depth + 1))
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value)) {
      if (inner !== undefined && typeof inner !== "function") {
        out[cleanText(key)] = cleanDeep(inner, depth + 1)
      }
    }
    return out
  }
  return undefined
}
