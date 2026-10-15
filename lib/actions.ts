"use server"

import { auth } from "@clerk/nextjs/server"
import { revalidatePath } from "next/cache"

import { db } from "@/lib/db"
import { bots } from "@/lib/db/schema"

type CreateBotInput = {
  name: string
  job: string
  instructions: string
  avatar: string
}

export async function createBot(
  input: CreateBotInput
): Promise<{ id: string } | { error: string }> {
  // Server Functions can be called directly, so check the user here too.
  const { userId } = await auth()
  if (!userId) {
    return { error: "You need to be signed in." }
  }

  const name = input.name.trim()
  const job = input.job.trim()
  const instructions = input.instructions.trim()
  const avatar = input.avatar.trim()

  if (!name || name.length > 60) {
    return { error: "Give the bot a name (up to 60 characters)." }
  }
  if (!job || job.length > 100) {
    return { error: "Give the bot a job (up to 100 characters)." }
  }
  if (instructions.length > 2000) {
    return { error: "Instructions can be up to 2000 characters." }
  }
  if (!avatar || avatar.length > 64) {
    return { error: "Pick a face." }
  }

  const [bot] = await db
    .insert(bots)
    .values({
      userId,
      name,
      job,
      instructions: instructions || null,
      avatar,
    })
    .returning({ id: bots.id })

  // The bot list lives in the sidebar on every page.
  revalidatePath("/", "layout")

  return { id: bot.id }
}
