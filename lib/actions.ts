"use server"

import { auth } from "@clerk/nextjs/server"
import { revalidatePath } from "next/cache"

import {
  cancelActiveRuns,
  cancelRun,
  getRunWithMessage,
} from "@/lib/agent/run-store"
import { liveAccess } from "@/lib/agent/start-run"
import {
  MAX_GROUP_BOTS,
  MAX_TITLE_LENGTH,
  insertChat,
  removeChat,
} from "@/lib/chat-store"
import {
  isActiveRunStatus,
  type RunHandle,
  type RunSnapshot,
} from "@/lib/chat-types"
import { db } from "@/lib/db"
import { bots } from "@/lib/db/schema"
import {
  deleteMemory,
  readMemory,
  writeMemory,
  type MemoryFile,
} from "@/lib/memory"
import { removeBot } from "@/lib/bot-delete"
import { getRunQueue } from "@/lib/providers"
import { resetSandbox as resetBotSandbox } from "@/lib/sandbox"

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

// The sidebar lists chats on every page, so anything that changes the list
// refreshes the whole layout.
function refreshChatList() {
  revalidatePath("/", "layout")
}

export async function createChat(
  botId: string
): Promise<{ id: string } | { error: string }> {
  const { userId } = await auth()
  if (!userId) {
    return { error: "You need to be signed in." }
  }
  if (typeof botId !== "string" || !botId) {
    return { error: "Pick a bot." }
  }

  const id = await insertChat(userId, { botIds: [botId] })
  if (!id) {
    return { error: "That bot doesn't exist." }
  }

  refreshChatList()
  return { id }
}

export async function createGroupChat(input: {
  name: string
  botIds: string[]
}): Promise<{ id: string } | { error: string }> {
  const { userId } = await auth()
  if (!userId) {
    return { error: "You need to be signed in." }
  }

  const name = typeof input.name === "string" ? input.name.trim() : ""
  const botIds = Array.isArray(input.botIds)
    ? [...new Set(input.botIds.filter((id) => typeof id === "string"))]
    : []

  if (!name || name.length > MAX_TITLE_LENGTH) {
    return {
      error: `Name the group (up to ${MAX_TITLE_LENGTH} characters).`,
    }
  }
  if (botIds.length === 0) {
    return { error: "Pick at least one bot." }
  }
  if (botIds.length > MAX_GROUP_BOTS) {
    return { error: `A group can have up to ${MAX_GROUP_BOTS} bots.` }
  }

  const id = await insertChat(userId, { botIds, title: name, group: true })
  if (!id) {
    return { error: "One of those bots doesn't exist." }
  }

  refreshChatList()
  return { id }
}

export async function deleteChat(
  chatId: string
): Promise<{ ok: true } | { error: string }> {
  const { userId } = await auth()
  if (!userId) {
    return { error: "You need to be signed in." }
  }
  if (typeof chatId !== "string" || !chatId) {
    return { error: "That chat doesn't exist." }
  }

  // Stop any reply that is still being written, so no worker keeps going for
  // a chat that no longer exists.
  await cancelActiveRuns(userId, chatId)

  if (!(await removeChat(userId, chatId))) {
    return { error: "That chat doesn't exist." }
  }

  refreshChatList()
  return { ok: true }
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64
}

// Stops a reply that is being written. Text that already arrived is kept.
// Returns where the run ended up, which may be "done" if it finished first.
export async function stopRun(
  runId: string
): Promise<{ run: RunSnapshot } | { error: string }> {
  const { userId } = await auth()
  if (!userId) {
    return { error: "You need to be signed in." }
  }
  if (!validId(runId)) {
    return { error: "That reply doesn't exist." }
  }

  // Only the chat's owner can stop its run.
  const run = await cancelRun(userId, runId)
  if (!run) {
    return { error: "That reply doesn't exist." }
  }

  refreshChatList()
  return { run }
}

// Called when a chat page loads with a reply still being written, so the
// screen can pick it up where it is. Returns the run's saved state, and a
// handle for following it if it's still unfinished. Null if the run isn't in
// one of this user's chats.
export async function attachRun(
  runId: string
): Promise<{ run: RunHandle | null; snapshot: RunSnapshot } | null> {
  const { userId } = await auth()
  if (!userId || !validId(runId)) {
    return null
  }

  // Scoped to the user: a run in someone else's chat doesn't exist here.
  const found = await getRunWithMessage(userId, runId)
  if (!found) {
    return null
  }

  const { run, snapshot } = found
  if (!isActiveRunStatus(run.status)) {
    return { run: null, snapshot }
  }

  return {
    run: {
      runId: run.id,
      assistantMessageId: run.assistantMessageId,
      botId: run.botId,
      live: await liveAccess(getRunQueue(), run.triggerRunId),
    },
    snapshot,
  }
}

// --- Bot memory (the Memory tab on a bot's settings page) ---
//
// Each of these checks who is signed in and passes that user's ID down; the
// memory functions then only see bots that user owns.

type MemoryActionError = {
  error: string
  // True when the file changed since it was opened: the screen offers to
  // reload it instead of overwriting.
  conflict?: boolean
}

function validMemoryPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200
}

export async function readMemoryFile(
  botId: string,
  path: string
): Promise<{ file: MemoryFile } | MemoryActionError> {
  const { userId } = await auth()
  if (!userId) {
    return { error: "You need to be signed in." }
  }
  if (!validId(botId) || !validMemoryPath(path)) {
    return { error: "That memory file doesn't exist." }
  }

  const file = await readMemory(userId, botId, path)
  return file ? { file } : { error: "That memory file doesn't exist." }
}

// Saves a file. expectedVersion is the version the editor loaded, or null for
// a new file; a save based on an older version is refused.
export async function saveMemoryFile(
  botId: string,
  input: { path: string; content: string; expectedVersion: number | null }
): Promise<{ path: string; version: number } | MemoryActionError> {
  const { userId } = await auth()
  if (!userId) {
    return { error: "You need to be signed in." }
  }

  const { path, content, expectedVersion } = input ?? {}
  if (
    !validId(botId) ||
    !validMemoryPath(path) ||
    typeof content !== "string" ||
    !(
      expectedVersion === null ||
      (Number.isInteger(expectedVersion) && expectedVersion >= 1)
    )
  ) {
    return { error: "That save wasn't valid." }
  }

  const result = await writeMemory(userId, botId, {
    path,
    content,
    expectedVersion,
  })
  if (!result.ok) {
    return { error: result.error, conflict: result.code === "conflict" }
  }

  revalidatePath(`/bot/${botId}/settings`)
  return result.file
}

export async function deleteMemoryFile(
  botId: string,
  path: string
): Promise<{ ok: true } | MemoryActionError> {
  const { userId } = await auth()
  if (!userId) {
    return { error: "You need to be signed in." }
  }
  if (!validId(botId) || !validMemoryPath(path)) {
    return { error: "That memory file doesn't exist." }
  }

  const result = await deleteMemory(userId, botId, path)
  if (!result.ok) {
    return { error: result.error }
  }

  revalidatePath(`/bot/${botId}/settings`)
  return { ok: true }
}

// --- A bot's own page: its sandbox and deleting it ---

// Throws away the bot's sandbox and everything in it. The next time the bot
// uses a sandbox it gets a fresh one.
export async function resetSandbox(
  botId: string
): Promise<{ ok: true } | { error: string }> {
  const { userId } = await auth()
  if (!userId) {
    return { error: "You need to be signed in." }
  }
  if (!validId(botId)) {
    return { error: "That bot doesn't exist." }
  }

  const result = await resetBotSandbox(userId, botId)
  if (!result.ok) {
    return { error: result.error }
  }

  revalidatePath(`/bot/${botId}/settings`)
  return { ok: true }
}

// Deletes a bot, its chats, its memory and its sandbox. This can't be undone.
export async function deleteBot(
  botId: string
): Promise<{ ok: true } | { error: string }> {
  const { userId } = await auth()
  if (!userId) {
    return { error: "You need to be signed in." }
  }
  if (!validId(botId)) {
    return { error: "That bot doesn't exist." }
  }

  const result = await removeBot(userId, botId)
  if (!result.ok) {
    return { error: result.error }
  }

  // The bot is listed in the sidebar on every page.
  revalidatePath("/", "layout")
  return { ok: true }
}

