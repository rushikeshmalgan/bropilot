// The 50 ready-made bot faces in public/bots/<name>.svg.
// A bot's `avatar` column stores one of these names.

export const BOT_FACES = [
  "ada",
  "bro",
  "pilot",
  "nova",
  "zen",
  "kai",
  "milo",
  "luna",
  "rex",
  "tess",
  "orbit",
  "pixel",
  "sage",
  "echo",
  "byte",
  "mango",
  "atlas",
  "juno",
  "finn",
  "iris",
  "dash",
  "cleo",
  "otto",
  "vega",
  "nico",
  "pearl",
  "ziggy",
  "moss",
  "ember",
  "sky",
  "r2",
  "bolt",
  "dot",
  "fizz",
  "gus",
  "hana",
  "ivy",
  "jax",
  "koda",
  "lumi",
  "max",
  "nyx",
  "oz",
  "pip",
  "quill",
  "rio",
  "sol",
  "tux",
  "uma",
  "vim",
] as const

export type BotFace = (typeof BOT_FACES)[number]

function hash(value: string): number {
  // FNV-1a
  let h = 2166136261
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

// Any stored value maps to one of the 50 faces, so bots created before this
// existed (with random seeds) still get a stable face.
export function faceFor(seed: string): BotFace {
  if ((BOT_FACES as readonly string[]).includes(seed)) return seed as BotFace
  return BOT_FACES[hash(seed) % BOT_FACES.length]
}

export function botFaceUrl(seed: string): string {
  return `/bots/${faceFor(seed)}.svg`
}

// A random face name, optionally different from the current one (for Shuffle).
export function randomBotFace(exclude?: string): BotFace {
  const pool = BOT_FACES.filter((face) => face !== exclude)
  return pool[Math.floor(Math.random() * pool.length)]
}
