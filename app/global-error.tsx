"use client"

// Shown when something breaks so badly that the page's own layout can't render.
// It replaces the root layout, so it brings its own <html>, <body> and styles
// and uses nothing that needs a provider. It never shows the error itself:
// that can contain details the person shouldn't see.
import { useEffect } from "react"

import "./globals.css"
import { errorReference, reportClientError } from "@/lib/observability-client"

export default function GlobalError({
  error,
  retry,
}: {
  error: unknown
  retry: () => void
}) {
  useEffect(() => {
    reportClientError(error)
    // This page has no theme provider, so follow the system setting.
    document.documentElement.classList.toggle(
      "dark",
      window.matchMedia("(prefers-color-scheme: dark)").matches
    )
  }, [error])

  const reference = errorReference(error)

  return (
    <html lang="en">
      <body className="bg-background text-foreground flex min-h-svh items-center justify-center p-6 font-sans antialiased">
        <main className="flex max-w-sm flex-col items-center gap-3 text-center">
          <h1 className="text-lg font-medium">Something went wrong</h1>
          <p className="text-muted-foreground text-sm">
            Bro Pilot hit a problem it couldn&apos;t recover from. Your chats
            are safe. Try again, and if it keeps happening, come back in a few
            minutes.
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => retry()}
              className="bg-primary text-primary-foreground h-9 rounded-md px-4 text-sm font-medium"
            >
              Try again
            </button>
            {/* A plain link on purpose: the app's router may be what broke. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a
              href="/"
              className="border-input h-9 content-center rounded-md border px-4 text-sm font-medium"
            >
              Go home
            </a>
          </div>
          {reference ? (
            <p className="text-muted-foreground mt-2 text-xs">
              Reference: {reference}
            </p>
          ) : null}
        </main>
      </body>
    </html>
  )
}
