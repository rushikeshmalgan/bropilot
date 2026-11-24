// Shows which environment variables are set, for each place the app runs.
//
//   npm run check:env
//
// Reads .env.local (the same file the app and the tests use). Prints names and
// "set" or "missing", never a value. Exits with 1 if a required variable is
// missing for the web server or the worker, so it can be used in a script.
import "./env"

import {
  ENV_VARIABLES,
  checkEnvironment,
  type EnvScope,
} from "../lib/env"

const SCOPE_TITLES: Record<EnvScope, string> = {
  web: "Next.js server (Railway, or `npm run dev`)",
  worker: "Trigger.dev worker (Trigger.dev environment, or `trigger dev`)",
  build: "Build (`next build`)",
  tools: "Scripts run by hand (db:push, smoke checks)",
}

let failed = false

for (const scope of Object.keys(SCOPE_TITLES) as EnvScope[]) {
  const report = checkEnvironment(scope)
  const missingRequired = new Set(report.missingRequired)
  const off = new Set(report.notConfigured.flatMap((item) => item.variables))

  console.log(`\n${SCOPE_TITLES[scope]}`)
  for (const variable of ENV_VARIABLES.filter((v) => v.scopes.includes(scope))) {
    // "Set" means the variable holds something the app can use.
    const present = Boolean(process.env[variable.name]?.trim())
    const state = missingRequired.has(variable.name)
      ? present
        ? "set, but not usable (required)"
        : "MISSING (required)"
      : off.has(variable.name)
        ? present
          ? "set, but not usable (a feature is off)"
          : "not set (a feature is off)"
        : present
          ? "set"
          : "not set"
    console.log(`  ${variable.name.padEnd(52)} ${state}`)
  }

  if (scope === "web" || scope === "worker") {
    failed ||= missingRequired.size > 0
  }
}

console.log(
  failed
    ? "\nRequired variables are missing (see MISSING above)."
    : "\nAll required variables are set."
)
process.exit(failed ? 1 : 0)
