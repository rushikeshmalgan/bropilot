"use client"

// What the chat page shows when it can't load or something in it breaks. The
// error itself is never shown, only a reference that matches the server log.
import { MessageCircleWarning } from "lucide-react"
import Link from "next/link"
import { useEffect } from "react"

import { Button, buttonVariants } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { errorReference, reportClientError } from "@/lib/observability-client"

export default function ChatError({
  error,
  retry,
}: {
  error: unknown
  retry: () => void
}) {
  useEffect(() => {
    reportClientError(error)
  }, [error])

  const reference = errorReference(error)

  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <Empty className="text-wrap">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MessageCircleWarning />
          </EmptyMedia>
          <EmptyTitle>This chat couldn&apos;t load</EmptyTitle>
          <EmptyDescription>
            Something went wrong on our side. Your messages are saved. Try
            again, and if it keeps happening, come back in a few minutes.
            {reference ? ` Reference: ${reference}.` : ""}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <div className="flex gap-2">
            <Button onClick={() => retry()}>Try again</Button>
            <Link href="/" className={buttonVariants({ variant: "outline" })}>
              Back to your bots
            </Link>
          </div>
        </EmptyContent>
      </Empty>
    </main>
  )
}
