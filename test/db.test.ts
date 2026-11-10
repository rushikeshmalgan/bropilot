import { eq } from "drizzle-orm"
import { afterAll, describe, expect, it } from "vitest"

import { insertChat, selectChat, selectChats } from "@/lib/chat-store"
import { db } from "@/lib/db"
import { bots } from "@/lib/db/schema"

import { cleanupUser, createTestBot, testUserId } from "./helpers/db"

// Proves the test database works and that cleanup leaves nothing behind.
describe("test database", () => {
  const owner = testUserId()
  const stranger = testUserId()

  afterAll(async () => {
    await cleanupUser(owner)
    await cleanupUser(stranger)
  })

  it("scopes chats to their owner", async () => {
    const bot = await createTestBot(owner)
    const chatId = await insertChat(owner, { botIds: [bot.id] })
    expect(chatId).toBeTruthy()

    expect(await selectChat(owner, chatId!)).toMatchObject({ id: chatId })
    expect(await selectChat(stranger, chatId!)).toBeNull()
    // Someone else's bot can't be put in a chat.
    expect(await insertChat(stranger, { botIds: [bot.id] })).toBeNull()
  })

  it("cleans up a test user's rows", async () => {
    const user = testUserId()
    const bot = await createTestBot(user)
    await insertChat(user, { botIds: [bot.id] })

    await cleanupUser(user)

    expect(await selectChats(user)).toEqual([])
    expect(await db.select().from(bots).where(eq(bots.userId, user))).toEqual(
      []
    )
  })
})
