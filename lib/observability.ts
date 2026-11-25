// The only way the rest of the app talks to Sentry. Without SENTRY_DSN every
// function here does nothing (and the Sentry SDK is never loaded), so the app
// runs exactly the same with or without it.
//
// The SDK is started elsewhere: by instrumentation.ts for the Next.js server,
// and by initWorkerTelemetry() for the Trigger.dev worker. Both come from the
// same package version, so they share one global Sentry state, and the
// functions here work in either process.
//
// Nothing here takes message text, memory content or tool output: only IDs
// and names that we choose. Whatever else ends up in an event is cleaned by
// lib/sentry-scrub.ts before it is sent.
import type * as SentryNode from "@sentry/node"

import { sentryOptions } from "@/lib/sentry-options"
import { cleanTags, type Tags } from "@/lib/sentry-scrub"

type SentryModule = typeof SentryNode

export type { Tags }

// What a span's code can do to it.
export type SpanHandle = {
  // Marks the span as failed, with a short reason of our own (not an error
  // message).
  fail: (reason: string) => void
}

const NO_SPAN: SpanHandle = { fail: () => {} }

// "Error" in Sentry's span status codes.
const SPAN_STATUS_ERROR = 2

export function telemetryEnabled() {
  return Boolean(process.env.SENTRY_DSN)
}

// The SDK, loaded on first use, or null when telemetry is off or the SDK
// can't be loaded. Telemetry must never be the reason something fails.
async function load(): Promise<SentryModule | null> {
  if (!telemetryEnabled()) {
    return null
  }
  try {
    return await import("@sentry/node")
  } catch {
    return null
  }
}

// Starts Sentry in a process that Next.js doesn't start it in (the Trigger.dev
// worker). Does nothing without SENTRY_DSN, or if Sentry is already running.
export async function initWorkerTelemetry() {
  const Sentry = await load()
  const dsn = process.env.SENTRY_DSN
  if (!Sentry || !dsn || Sentry.getClient()) {
    return
  }
  try {
    Sentry.init(sentryOptions(dsn))
  } catch {
    // A broken Sentry setup must not stop replies.
  }
}

// Only short, plain values we chose ourselves are sent as span attributes.
const SAFE_ATTRIBUTE = /^[\w .:/-]{0,64}$/

function cleanAttributes(attributes: Record<string, string | number | boolean>) {
  const out: Record<string, string | number | boolean> = {}
  for (const [name, value] of Object.entries(attributes)) {
    if (typeof value === "string" ? SAFE_ATTRIBUTE.test(value) : true) {
      out[name] = value
    }
  }
  return out
}

// Runs `fn` inside a span. `name` and `attributes` are for names and IDs we
// choose, never for text a user or a tool produced. If `fn` throws, the span is
// marked failed and the error goes on to the caller unchanged.
export async function withSpan<T>(
  spec: {
    name: string
    op: string
    attributes?: Record<string, string | number | boolean>
  },
  fn: (span: SpanHandle) => Promise<T>
): Promise<T> {
  const Sentry = await load()
  if (!Sentry) {
    return fn(NO_SPAN)
  }

  return Sentry.startSpan(
    {
      name: spec.name,
      op: spec.op,
      attributes: cleanAttributes(spec.attributes ?? {}),
    },
    (span) =>
      fn({
        fail: (reason) => {
          try {
            span.setStatus({ code: SPAN_STATUS_ERROR, message: reason })
          } catch {
            // Telemetry only.
          }
        },
      })
  )
}

// Everything captured or traced inside `fn` carries its own tags, and tags set
// inside don't leak into other runs handled by the same process.
export async function withTelemetryScope<T>(fn: () => Promise<T>): Promise<T> {
  const Sentry = await load()
  if (!Sentry) {
    return fn()
  }
  return Sentry.withIsolationScope(() => fn())
}

// Adds userId / botId / chatId / runId to everything sent from the current
// scope (see withTelemetryScope). Values that don't look like IDs are dropped.
export async function tagTelemetry(tags: Tags) {
  const Sentry = await load()
  if (!Sentry) {
    return
  }
  try {
    Sentry.getIsolationScope().setTags(cleanTags(tags))
  } catch {
    // Telemetry only.
  }
}

// Reports an error. `tags` adds IDs for this error only. Returns once the
// error has been handed to the SDK; flushTelemetry waits for it to be sent.
export async function captureError(error: unknown, tags: Tags = {}) {
  const Sentry = await load()
  if (!Sentry) {
    return
  }
  try {
    Sentry.withScope((scope) => {
      scope.setTags(cleanTags(tags))
      Sentry.captureException(error)
    })
  } catch {
    // Telemetry only.
  }
}

// Waits (up to `timeoutMs`) for queued events to be sent. A task must call
// this before it exits, or events from its last moments can be lost.
export async function flushTelemetry(timeoutMs = 2000) {
  const Sentry = await load()
  if (!Sentry) {
    return
  }
  try {
    await Sentry.flush(timeoutMs)
  } catch {
    // Telemetry only.
  }
}
