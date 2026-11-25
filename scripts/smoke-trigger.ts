// Proves the Trigger.dev adapter works against the real service.
//
//   npx tsx scripts/smoke-trigger.ts          queue, token and cancel only
//   npx tsx scripts/smoke-trigger.ts --full   a whole reply, start to finish
//
// The default check needs only TRIGGER_SECRET_KEY: it queues a run for an ID
// that doesn't exist, makes a read token for it and cancels it. Nothing is
// written to the database and the model is never called.
//
// --full also needs `npx trigger.dev@latest dev` running in another terminal.
// It creates a throwaway user, bot and chat, sends one message, waits for the
// worker to write the reply (one real model call), checks the live updates
// with the read token, and deletes everything again.
import "./env"

import { auth, runs } from "@trigger.dev/sdk"
import { nanoid } from "nanoid"

import { hasEnv } from "./env"

// Throws instead of exiting, so the `finally` blocks that remove what the
// check created still run. The handler at the bottom prints it and exits 1.
function fail(message: string): never {
  throw new Error(message)
}

async function basic() {
  const { triggerRunQueue } = await import("@/lib/providers/run-queue")
  const runId = `smoke-${nanoid(8)}`

  const { externalId } = await triggerRunQueue.enqueue(runId)
  if (!externalId.startsWith("run_")) {
    fail(`unexpected run ID shape: ${externalId.slice(0, 8)}…`)
  }
  console.log(`ok   queued a run (${externalId})`)

  // Queuing the same run again must not create a second one.
  const again = await triggerRunQueue.enqueue(runId)
  if (again.externalId !== externalId) {
    fail("the same run was queued twice")
  }
  console.log("ok   queuing it again returned the same run")

  const token = await triggerRunQueue.createReadToken(externalId)
  if (!token) {
    fail("no read token was created")
  }
  console.log(`ok   created a read token (${token.length} characters)`)

  // The token can read this run...
  const seen = await auth.withAuth({ accessToken: token }, async () =>
    runs.retrieve(externalId)
  )
  console.log(`ok   the token can read its own run (status ${seen.status})`)

  // ...and nothing else: it can't queue or cancel.
  const overreach = await auth
    .withAuth({ accessToken: token }, async () => runs.cancel(externalId))
    .then(
      () => true,
      () => false
    )
  if (overreach) {
    fail("the read token was able to cancel a run")
  }
  console.log("ok   the token cannot cancel a run")

  await triggerRunQueue.cancel(externalId)
  const after = await runs.retrieve(externalId)
  console.log(`ok   cancelled it (status ${after.status})`)
}

async function full() {
  if (!hasEnv("DATABASE_URL", "GOOGLE_GENERATIVE_AI_API_KEY")) {
    fail("--full needs DATABASE_URL and GOOGLE_GENERATIVE_AI_API_KEY")
  }

  const { eq } = await import("drizzle-orm")
  const { db } = await import("@/lib/db")
  const { bots, chats } = await import("@/lib/db/schema")
  const { insertChat } = await import("@/lib/chat-store")
  const { startRun } = await import("@/lib/agent/start-run")
  const { getRunSnapshot } = await import("@/lib/agent/run-store")
  const { textOfParts } = await import("@/lib/chat-types")
  const { readLiveProgress } = await import("@/lib/run-progress")

  const userId = `smoke_${nanoid(10)}`
  try {
    const [bot] = await db
      .insert(bots)
      .values({
        userId,
        name: "Smoke",
        job: "Smoke test",
        avatar: "ada",
        instructions: "Reply with exactly one short sentence.",
      })
      .returning()
    const chatId = await insertChat(userId, { botIds: [bot.id] })
    if (!chatId) {
      fail("couldn't create the test chat")
    }

    const started = await startRun({
      userId,
      chatId,
      text: "Say hello in five words or fewer.",
      plan: "pro",
    })
    if (!started.ok) {
      fail(`the message was refused: ${started.code}`)
    }
    console.log("ok   saved the message and queued the run")

    const live = started.run.live
    if (!live) {
      fail("no live access was returned")
    }

    // Watch the run with the browser's token while the worker writes.
    let liveUpdates = 0
    let lastSeq = 0
    const watching = auth.withAuth({ accessToken: live.token }, async () => {
      for await (const run of runs.subscribeToRun(live.externalId)) {
        const update = readLiveProgress(run.metadata?.progress, lastSeq)
        if (update) {
          lastSeq = update.seq
          liveUpdates++
        }
      }
    })

    const deadline = Date.now() + 150_000
    let snapshot = await getRunSnapshot(userId, started.run.runId)
    while (
      snapshot &&
      (snapshot.status === "queued" || snapshot.status === "running")
    ) {
      if (Date.now() > deadline) {
        fail(
          `the run is still ${snapshot.status}. Is \`npx trigger.dev@latest dev\` running?`
        )
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
      snapshot = await getRunSnapshot(userId, started.run.runId)
    }

    if (!snapshot) {
      fail("the run disappeared")
    }
    if (snapshot.status !== "done" || !snapshot.message) {
      fail(`the run ended as ${snapshot.status}: ${snapshot.error ?? "no error"}`)
    }
    const text = textOfParts(snapshot.message.parts)
    console.log(`ok   the worker wrote a reply (${text.length} characters)`)

    await Promise.race([
      watching,
      new Promise((resolve) => setTimeout(resolve, 15_000)),
    ])
    if (liveUpdates === 0) {
      fail("no live update arrived through the read token")
    }
    console.log(`ok   ${liveUpdates} live update(s) arrived through the read token`)
  } finally {
    await db.delete(chats).where(eq(chats.userId, userId))
    await db.delete(bots).where(eq(bots.userId, userId))
    console.log("ok   removed the test rows")
  }
}

async function main() {
  if (!hasEnv("TRIGGER_SECRET_KEY")) {
    console.log("SKIP: TRIGGER_SECRET_KEY is not set.")
    return
  }

  const { hasTriggerKey } = await import("@/lib/providers")
  if (!hasTriggerKey()) {
    fail(
      "TRIGGER_SECRET_KEY is set but isn't a Trigger.dev secret key. Copy the Development secret key (it starts with tr_dev_) from the project's API keys page; a masked value or a personal access token (tr_pat_) won't work."
    )
  }

  await basic()
  if (process.argv.includes("--full")) {
    await full()
  }
  console.log("PASS")
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
)
