// Checks the Sentry setup end to end against the real service: starts the SDK
// with the app's own options, sends one test error, and reports what Sentry
// answered.
//
//   npx tsx scripts/smoke-sentry.ts
//
// Needs SENTRY_DSN in .env.local; without it this says so and does nothing.
// The test error contains a fake key and a fake sentence of "message text", so
// when you open the event in Sentry you can see both were removed. The script
// also checks the event as it leaves this machine.
import "./env"

async function main() {
  const dsn = process.env.SENTRY_DSN
  if (!dsn) {
    console.log("SENTRY_DSN is not set in .env.local: nothing to check.")
    return
  }

  const Sentry = await import("@sentry/node")
  const { sentryOptions } = await import("@/lib/sentry-options")
  const options = sentryOptions(dsn)

  // What the SDK sends, and what Sentry answered. flush() alone only says the
  // queue emptied, not that Sentry accepted anything.
  const statuses: (number | string)[] = []
  let sent = ""

  Sentry.init({
    ...options,
    tracesSampleRate: 1,
    transport: (transportOptions) => {
      const real = Sentry.makeNodeTransport(transportOptions)
      return {
        send: async (envelope) => {
          sent += JSON.stringify(envelope)
          try {
            const response = await real.send(envelope)
            statuses.push(response.statusCode ?? "no status")
            return response
          } catch (error) {
            statuses.push(error instanceof Error ? error.name : "failed")
            throw error
          }
        },
        flush: (timeout) => real.flush(timeout),
      }
    },
  })

  const fakeKey = "sk-smoke0123456789abcdefghijklmnop"
  const error = new Error(
    `Smoke test (not a real error). Key ${fakeKey}. Message: {"content": "hello from a user"}`
  )

  await Sentry.startSpan({ name: "smoke test", op: "smoke" }, async () => {
    Sentry.withScope((scope) => {
      scope.setTags({
        userId: "smoke_user",
        botId: "smoke_bot",
        chatId: "smoke_chat",
        runId: "smoke_run",
      })
      Sentry.captureException(error)
    })
  })

  await Sentry.flush(10_000)

  const leaked =
    sent.includes(fakeKey) ||
    sent.includes(fakeKey.slice(5)) ||
    sent.includes("hello from a user")
  console.log(
    leaked
      ? "FAIL: the fake key or message text is still in what was sent."
      : "The fake key and message text were removed from what was sent."
  )

  const accepted = statuses.length > 0 && statuses.every((s) => s === 200)
  console.log(
    accepted
      ? `Sentry accepted it (HTTP ${statuses.join(", ")}). Look for "Smoke test" in Sentry with the tags userId smoke_user and runId smoke_run.`
      : `Sentry did NOT accept it: answers were [${statuses.join(", ") || "none"}]. Check the DSN and the network.`
  )

  process.exitCode = accepted && !leaked ? 0 : 1
}

main().then(
  () => process.exit(),
  (error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
)
