import { eq, sql } from "drizzle-orm"
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
  await db.execute(sql`delete from usage where user_id = ${userId}`)
}

// Writes a user's usage for a month directly, for tests that start from a
// nearly used-up allowance.
export async function setUsage(
  userId: string,
  month: string,
  values: {
    runs?: number
    sandboxMinutes?: number
    inputTokens?: number
    outputTokens?: number
  }
) {
  await db.execute(sql`
    insert into usage (user_id, month, runs, sandbox_minutes, input_tokens, output_tokens)
    values (${userId}, ${month}, ${values.runs ?? 0}, ${values.sandboxMinutes ?? 0}, ${values.inputTokens ?? 0}, ${values.outputTokens ?? 0})
    on conflict (user_id, month) do update set
      runs = excluded.runs,
      sandbox_minutes = excluded.sandbox_minutes,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens
  `)
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
