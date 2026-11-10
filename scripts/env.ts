// Scripts run outside Next.js, so they load .env.local themselves. Import this
// first in a script.
import { config } from "dotenv"

config({ path: ".env.local", quiet: true })

// True when every named variable has a value. Never prints the values.
export function hasEnv(...names: string[]) {
  return names.every((name) => Boolean(process.env[name]))
}
