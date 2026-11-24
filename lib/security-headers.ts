// The security headers sent with every response (next.config.ts adds them).
//
// Two Content-Security-Policy headers go out:
//
//  - An enforced one with only the directives that can't stop the app from
//    loading anything: nobody may put these pages in a frame, no <base> tag
//    tricks, no plugins.
//  - A full policy in report-only mode. Browsers log what it WOULD block to the
//    console and block nothing. It exists so the allowed hosts can be checked
//    in a real signed-in session before the policy is enforced: the screen
//    viewer's host (Daytona) and a few others couldn't be checked without one.
//    To enforce it, open the app signed in, use a chat with a screen, read the
//    console for "[Report Only]" messages, add any host that is missing, and
//    then send the policy as Content-Security-Policy instead.
//
// This file uses only relative imports: next.config.ts loads it before the "@"
// alias exists.

export type Header = { key: string; value: string }

type Options = {
  production: boolean
  // Clerk's frontend host, e.g. "example-12.clerk.accounts.dev".
  clerkHost?: string | null
  // The Sentry DSN, to allow its ingest host (the DSN is not a secret).
  sentryDsn?: string | null
}

// The host Clerk's browser code talks to is written into the publishable key:
// pk_test_ or pk_live_ followed by the host in base64, ending with "$".
export function clerkHostFromKey(key: string | undefined): string | null {
  const encoded = key?.split("_")[2]
  if (!encoded) {
    return null
  }
  try {
    const host = atob(encoded).replace(/\$$/, "")
    return /^[a-z0-9.-]+$/i.test(host) ? host : null
  } catch {
    return null
  }
}

function sentryHostFromDsn(dsn: string | null | undefined): string | null {
  if (!dsn) {
    return null
  }
  try {
    return new URL(dsn).host
  } catch {
    return null
  }
}

// The directives that are safe to enforce straight away.
export const ENFORCED_CSP = [
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join("; ")

export function reportOnlyCsp({
  production,
  clerkHost,
  sentryDsn,
}: Options): string {
  const clerk = clerkHost ? [`https://${clerkHost}`] : []
  const sentry = sentryHostFromDsn(sentryDsn)

  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    // Next.js writes small inline scripts into every page, so 'unsafe-inline'
    // stays until a per-request nonce is added. 'unsafe-eval' is for the
    // development server only.
    "script-src": [
      "'self'",
      "'unsafe-inline'",
      ...(production ? [] : ["'unsafe-eval'"]),
      ...clerk,
      "https://challenges.cloudflare.com",
    ],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:", "https://img.clerk.com"],
    "font-src": ["'self'", "data:"],
    "connect-src": [
      "'self'",
      ...clerk,
      "https://clerk-telemetry.com",
      // Live updates from Trigger.dev while a reply is written.
      "https://api.trigger.dev",
      "wss://api.trigger.dev",
      ...(sentry ? [`https://${sentry}`] : []),
    ],
    // The screen viewer is a page from the sandbox provider, so its host isn't
    // known here; any https page is reported as allowed until it is checked.
    "frame-src": ["'self'", "https://challenges.cloudflare.com", "https:"],
    "worker-src": ["'self'", "blob:"],
    "frame-ancestors": ["'none'"],
    "base-uri": ["'self'"],
    "object-src": ["'none'"],
    "form-action": ["'self'", ...clerk],
  }

  return Object.entries(directives)
    .map(([name, sources]) => `${name} ${sources.join(" ")}`)
    .join("; ")
}

export function securityHeaders(options: Options): Header[] {
  return [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    {
      key: "Permissions-Policy",
      value:
        "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
    },
    { key: "Content-Security-Policy", value: ENFORCED_CSP },
    {
      key: "Content-Security-Policy-Report-Only",
      value: reportOnlyCsp(options),
    },
    // Only over HTTPS, which production is; sending it from http://localhost
    // would be ignored by browsers anyway.
    ...(options.production
      ? [
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains",
          },
        ]
      : []),
  ]
}
