"use client"

import * as React from "react"
import { useRealtimeRun } from "@trigger.dev/react-hooks"

import type { MessagePart, RunHandle, RunSnapshot } from "@/lib/chat-types"
import {
  POLL_INTERVAL_MS,
  POLL_INTERVAL_WITH_LIVE_MS,
  fetchRunSnapshot,
  followRun,
  readLiveProgress,
  type RunFollower as Follower,
} from "@/lib/run-progress"

type RunFollowerProps = {
  run: RunHandle
  // The saved state of the run. The last call is always the finished state.
  onSnapshot: (snapshot: RunSnapshot) => void
  // Text that arrived live, ahead of the next saved state.
  onProgress: (parts: MessagePart[]) => void
  // The run no longer exists (its chat was deleted somewhere else).
  onGone: () => void
}

// Follows one run until it finishes. Renders nothing. Mount it with the run's
// ID as its key so each run gets a fresh follower.
export function RunFollower({
  run,
  onSnapshot,
  onProgress,
  onGone,
}: RunFollowerProps) {
  // The newest callbacks, so the polling loop doesn't restart on every render.
  const handlers = React.useRef({ onSnapshot, onProgress, onGone })
  React.useEffect(() => {
    handlers.current = { onSnapshot, onProgress, onGone }
  })

  const liveHealthy = React.useRef(false)
  const follower = React.useRef<Follower | null>(null)

  React.useEffect(() => {
    const current = followRun({
      runId: run.runId,
      fetchSnapshot: fetchRunSnapshot,
      intervalMs: () =>
        liveHealthy.current ? POLL_INTERVAL_WITH_LIVE_MS : POLL_INTERVAL_MS,
      onSnapshot: (snapshot) => {
        const finished =
          snapshot.status !== "queued" && snapshot.status !== "running"
        // While live updates are flowing they are ahead of the database, so an
        // unfinished saved state would only move the text backwards.
        if (finished || !liveHealthy.current) {
          handlers.current.onSnapshot(snapshot)
        }
      },
      onGone: () => handlers.current.onGone(),
    })
    follower.current = current

    return () => {
      current.stop()
      follower.current = null
    }
  }, [run.runId])

  if (!run.live) {
    return null
  }

  return (
    <LiveUpdates
      live={run.live}
      onProgress={(parts) => {
        liveHealthy.current = true
        if (parts) {
          handlers.current.onProgress(parts)
        } else {
          // Too large to send live; read it from the database.
          follower.current?.poke()
        }
      }}
      onUnavailable={() => {
        liveHealthy.current = false
        follower.current?.poke()
      }}
      onFinished={() => follower.current?.poke()}
    />
  )
}

// Trigger.dev realtime for one run, using a token that can read only that run.
// If it fails for any reason the follower above carries on by polling.
function LiveUpdates({
  live,
  onProgress,
  onUnavailable,
  onFinished,
}: {
  live: NonNullable<RunHandle["live"]>
  onProgress: (parts: MessagePart[] | null) => void
  onUnavailable: () => void
  onFinished: () => void
}) {
  const { run, error } = useRealtimeRun(live.externalId, {
    accessToken: live.token,
  })

  const handlers = React.useRef({ onProgress, onUnavailable, onFinished })
  React.useEffect(() => {
    handlers.current = { onProgress, onUnavailable, onFinished }
  })

  const lastSeq = React.useRef(0)
  const progress = run?.metadata?.progress
  const finished = Boolean(run?.finishedAt)

  React.useEffect(() => {
    const update = readLiveProgress(progress, lastSeq.current)
    if (update) {
      lastSeq.current = update.seq
      handlers.current.onProgress(update.parts)
    }
  }, [progress])

  React.useEffect(() => {
    if (finished) {
      handlers.current.onFinished()
    }
  }, [finished])

  React.useEffect(() => {
    if (error) {
      handlers.current.onUnavailable()
    }
  }, [error])

  return null
}
