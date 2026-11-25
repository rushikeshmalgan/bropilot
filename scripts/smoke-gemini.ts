// Proves a whole reply works with the real model and the real database, with
// no task queue involved: the run is executed in this process.
//
//   npx tsx scripts/smoke-gemini.ts
//
// It creates a throwaway user, bot and chat, sends one message, runs the reply
// (one real model call) and deletes everything again.
import "./env"

import { eq } from "drizzle-orm"
import { nanoid } from "nanoid"

import { hasEnv } from "./env"

// Throws instead of exiting, so the `finally` blocks that remove what the
// check created still run. The handler at the bottom prints it and exits 1.
function fail(message: string): never {
  throw new Error(message)
}

async function main() {
  if (!hasEnv("GOOGLE_GENERATIVE_AI_API_KEY", "DATABASE_URL")) {
    console.log("SKIP: GOOGLE_GENERATIVE_AI_API_KEY or DATABASE_URL is not set.")
    return
  }

  const { db } = await import("@/lib/db")
  const { bots, chats, messages } = await import("@/lib/db/schema")
  const { insertChat } = await import("@/lib/chat-store")
  const { startRun } = await import("@/lib/agent/start-run")
  const { executeRun } = await import("@/lib/agent/execute-run")
  const { getRunSnapshot } = await import("@/lib/agent/run-store")
  const { overrideProviders } = await import("@/lib/providers")
  const { textOfParts } = await import("@/lib/chat-types")

  // A queue that only remembers the run, so it can be executed right here.
  const queued: string[] = []
  overrideProviders({
    runQueue: {
      enqueue: async (runId) => {
        queued.push(runId)
        return { externalId: `local_${runId}` }
      },
      createReadToken: async () => null,
      cancel: async () => {},
    },
  })

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

    const result = await executeRun(queued[0])
    const snapshot = await getRunSnapshot(userId, started.run.runId)
    if (result.status !== "done" || !snapshot?.message) {
      fail(`the run ended as ${result.status}: ${snapshot?.error ?? "no error"}`)
    }

    const [saved] = await db
      .select()
      .from(messages)
      .where(eq(messages.id, started.run.assistantMessageId))
    console.log(
      `ok   the model replied (${textOfParts(snapshot.message.parts).length} characters, ${saved.usage?.totalTokens ?? "?"} tokens)`
    )
    console.log("PASS")
  } finally {
    await db.delete(chats).where(eq(chats.userId, userId))
    await db.delete(bots).where(eq(bots.userId, userId))
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
)
