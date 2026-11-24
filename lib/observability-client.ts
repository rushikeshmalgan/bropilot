// Reports an error that React caught in the browser (an error boundary), which
// Sentry's own handlers never see. Does nothing without a DSN in the build.
export function reportClientError(error: unknown) {
  if (!process.env.NEXT_PUBLIC_SENTRY_DSN) {
    return
  }
  void import("@sentry/nextjs").then(
    (Sentry) => Sentry.captureException(error),
    () => {}
  )
}

// The short code Next.js adds to errors from the server. It matches the server
// log and the Sentry event, and contains nothing about what went wrong.
export function errorReference(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { digest?: unknown }).digest === "string"
  ) {
    return (error as { digest: string }).digest.slice(0, 40)
  }
  return null
}
