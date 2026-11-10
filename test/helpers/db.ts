import { eq } from "drizzle-orm"
import { nanoid } from "nanoid"

import { db } from "@/lib/db"
import { bots, chats } from "@/lib/db/schema"

// A user ID no real account has, so test rows can't mix with real ones.
export function testUserId() {
  return `test_${nanoid(12)}`
}

// Removes everything a test user owns. Chats take their messages with them.
export async function cleanupUser(userId: string) {
  await db.delete(chats).where(eq(chats.userId, userId))
  await db.delete(bots).where(eq(bots.userId, userId))
}

export async function createTestBot(
  userId: string,
  values: Partial<typeof bots.$inferInsert> = {}
) {
  const [bot] = await db
    .insert(bots)
    .values({
      userId,
      name: "Testbot",
      job: "Tester",
      avatar: "ada",
      ...values,
    })
    .returning()
  return bot
}
