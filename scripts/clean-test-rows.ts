// Removes rows left behind by a test or smoke run that was killed before it
// could clean up after itself.
//
//   npx tsx scripts/clean-test-rows.ts
//
// Only rows owned by throwaway users are touched: tests use IDs starting with
// "test_" and smoke scripts "smoke_". Real Clerk user IDs start with "user_".
import "./env"

import { like, or } from "drizzle-orm"

async function main() {
  const { db } = await import("@/lib/db")
  const { bots, chats } = await import("@/lib/db/schema")

  // Chats first: they take their messages and runs with them.
  const removedChats = await db
    .delete(chats)
    .where(or(like(chats.userId, "test\\_%"), like(chats.userId, "smoke\\_%")))
    .returning({ id: chats.id })
  const removedBots = await db
    .delete(bots)
    .where(or(like(bots.userId, "test\\_%"), like(bots.userId, "smoke\\_%")))
    .returning({ id: bots.id })

  console.log(
    `Removed ${removedChats.length} chat(s) and ${removedBots.length} bot(s) left by tests.`
  )
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
)
