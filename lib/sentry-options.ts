// The one set of options every Sentry.init in this app uses (the Next.js
// server, the edge, the browser, and the Trigger.dev worker), so the privacy
// rules can't differ between them.
//
// Sentry docs: https://docs.sentry.io/platforms/javascript/guides/nextjs/
// (options), and the data collection options in "Data Collected".
import {
  scrubBreadcrumb,
  scrubEvent,
  scrubSpan,
} from "@/lib/sentry-scrub"

// Share of requests and runs that send a trace. Errors are always sent.
export const DEFAULT_TRACES_SAMPLE_RATE = 0.1

// SENTRY_TRACES_SAMPLE_RATE as a number from 0 to 1. Anything else falls back
// to the default rather than breaking start-up.
export function tracesSampleRate(raw: string | undefined) {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_TRACES_SAMPLE_RATE
  }
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    return DEFAULT_TRACES_SAMPLE_RATE
  }
  return value
}

// Integrations the SDK turns on by itself that would record what this app is
// built to keep out: what was sent to and said by the model, console output,
// the values of local variables, and recordings of the screen.
const UNWANTED_INTEGRATIONS = new Set([
  "VercelAI",
  "OpenAI",
  "Anthropic_AI",
  "GoogleGenAI",
  "LangChain",
  "LangGraph",
  "Mastra",
  "PiAi",
  "PiDurable",
  "Console",
  "LocalVariables",
  "LocalVariablesAsync",
  "Replay",
  "ReplayCanvas",
  "Feedback",
])

export function sentryOptions(dsn: string) {
  return {
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV,
    tracesSampleRate: tracesSampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE),
    maxBreadcrumbs: 30,
    // Nothing about the person or what they sent is collected by the SDK
    // itself. What is sent on purpose goes through the scrubbers below.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      mcp: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    },
    // Errors go through beforeSend. Spans are streamed on their own (Sentry
    // 11's default), so they go through beforeSendSpan: beforeSendTransaction
    // is ignored in that mode.
    integrations: <T extends { name: string }>(defaults: T[]): T[] =>
      defaults.filter((integration) => !UNWANTED_INTEGRATIONS.has(integration.name)),
    beforeSend: scrubEvent,
    beforeSendSpan: scrubSpan,
    beforeBreadcrumb: scrubBreadcrumb,
  }
}
