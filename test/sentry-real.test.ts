// The real Sentry SDK, with its network transport swapped for one that keeps
// what it was asked to send. This checks that the scrubbers work on events and
// spans as the SDK really builds them, and that the tags arrive.
import * as Sentry from "@sentry/node"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  captureError,
  flushTelemetry,
  tagTelemetry,
  withSpan,
  withTelemetryScope,
} from "@/lib/observability"
import { sentryOptions } from "@/lib/sentry-options"

type Item = [Record<string, unknown>, unknown]
const envelopes: Item[][] = []

const DSN = "https://publickey@o0.ingest.example/1"

// Made up, and built in pieces so no scanner takes them for real keys.
const FAKE_KEY = ["sk", "-", "Real0123456789abcdefghijklmnop"].join("")
const PRIVATE_TEXT = "MY PRIVATE MESSAGE ABOUT THE SURPRISE PARTY"

function everythingSent() {
  return JSON.stringify(envelopes)
}

beforeAll(async () => {
  process.env.SENTRY_DSN = DSN
  Sentry.init({
    ...sentryOptions(DSN),
    tracesSampleRate: 1,
    transport: () => ({
      send: async (envelope: unknown) => {
        envelopes.push((envelope as [unknown, Item[]])[1])
        return {}
      },
      flush: async () => true,
    }),
  })

  // One run's worth of telemetry: tags, a span with a child, and an error.
  await withTelemetryScope(async () => {
    await tagTelemetry({
      userId: "user_2realtest",
      botId: "bot_realtest",
      chatId: "chat_realtest",
      runId: "run_realtest",
    })
    await withSpan(
      {
        name: "run",
        op: "run",
        attributes: { "run.id": "run_realtest" },
      },
      async () => {
        await withSpan(
          { name: "tool webSearch", op: "tool", attributes: { "tool.name": "webSearch" } },
          async (span) => {
            span.fail("tool returned an error")
          }
        )
        await captureError(new Error(`Provider rejected key ${FAKE_KEY}.`))
        await captureError(
          new Error(`Invalid prompt: {"content": "${PRIVATE_TEXT}"}`)
        )
      }
    )
  })

  await flushTelemetry(5000)
})

afterAll(async () => {
  delete process.env.SENTRY_DSN
  await Sentry.close(1000)
})

describe("the real Sentry SDK with the app's options", () => {
  it("sends the error with its four tags, and nothing that was in the message or the key", () => {
    const items = envelopes.flat()
    const errorItems = items.filter(([header]) => header.type === "event")
    expect(errorItems, "two error events were sent").toHaveLength(2)

    type ErrorEvent = {
      tags?: Record<string, string>
      exception?: { values?: { type?: string; value?: string }[] }
      user?: unknown
      request?: unknown
      server_name?: unknown
      extra?: unknown
    }
    const [withKey, withContent] = errorItems.map(([, payload]) => payload as ErrorEvent)

    for (const event of [withKey, withContent]) {
      expect(event.tags).toMatchObject({
        userId: "user_2realtest",
        botId: "bot_realtest",
        chatId: "chat_realtest",
        runId: "run_realtest",
      })
      expect(event.exception?.values?.[0]?.type).toBe("Error")
      expect(event.server_name).toBeUndefined()
      expect(event.extra).toBeUndefined()
    }
    // The key is cut out of the message; the rest of it stays so the error
    // can still be understood. A message that carried what someone wrote is
    // replaced whole.
    expect(withKey.exception?.values?.[0]?.value).toBe("Provider rejected key [redacted].")
    expect(withContent.exception?.values?.[0]?.value).toContain("[redacted]")

    const text = everythingSent()
    expect(text).not.toContain(FAKE_KEY)
    expect(text).not.toContain(FAKE_KEY.slice(6))
    expect(text).not.toContain("SURPRISE PARTY")

    // The SDK really did start without the integrations that record what the
    // model was sent, console output and local variables.
    const integrations = (withKey as { sdk?: { integrations?: string[] } }).sdk?.integrations ?? []
    expect(integrations.length).toBeGreaterThan(3)
    for (const unwanted of ["VercelAI", "OpenAI", "Console", "LocalVariablesAsync"]) {
      expect(integrations).not.toContain(unwanted)
    }
  })

  it("sends the spans, named after what they time, with only names and IDs in them", () => {
    const items = envelopes.flat()
    const spans = items
      .filter(([header]) => header.type === "span")
      .flatMap(([, payload]) => (payload as { items?: { name: string; attributes: Record<string, unknown> }[] }).items ?? [])

    const names = spans.map((span) => span.name)
    expect(names).toContain("run")
    expect(names).toContain("tool webSearch")

    const tool = spans.find((span) => span.name === "tool webSearch")
    expect(JSON.stringify(tool?.attributes)).toContain("webSearch")
  })
})
