import { auth } from "@clerk/nextjs/server"
import { and, desc, eq } from "drizzle-orm"
import { cache } from "react"

import { db } from "@/lib/db"
import { bots } from "@/lib/db/schema"

// The signed-in user's bots, newest first. Cached per request so the shell and
// the page can both ask for it without a second query.
export const listBots = cache(async () => {
  const { userId } = await auth.protect()

  return db
    .select()
    .from(bots)
    .where(eq(bots.userId, userId))
    .orderBy(desc(bots.createdAt))
})

// One of the signed-in user's bots, or null if it doesn't exist or belongs to
// someone else.
export async function getBot(id: string) {
  const { userId } = await auth.protect()

  const [bot] = await db
    .select()
    .from(bots)
    .where(and(eq(bots.id, id), eq(bots.userId, userId)))
    .limit(1)

  return bot ?? null
}
