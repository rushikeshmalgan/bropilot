// One table for the rule that matters most: someone else's chat, run, bot,
// memory, sandbox and screen must look exactly as if they didn't exist, and
// nothing about them may change. Every way into the app is tried by a second
// user with the first user's IDs, and then by nobody who is signed in.
import { eq, inArray } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { GET as getRun } from "@/app/api/runs/[id]/route"
import { GET as getScreen, POST as postScreen } from "@/app/api/bots/[id]/screen/route"
import { POST as postChat } from "@/app/api/chat/route"
import {
  attachRun,
  createChat,
  createGroupChat,
  deleteBot,
  deleteChat,
  deleteMemoryFile,
  readMemoryFile,
  resetSandbox,
  saveMemoryFile,
  stopRun,
} from "@/lib/actions"
import { executeRun } from "@/lib/agent/execute-run"
import { db } from "@/lib/db"
import { botMemoryFiles, bots, chats, messages, runs } from "@/lib/db/schema"
import { getOrCreateChatForBot, loadChatPage } from "@/lib/chats"
import { writeMemory } from "@/lib/memory"
import { overrideProviders, resetProviderOverrides } from "@/lib/providers"
import { getOrCreateSandbox } from "@/lib/sandbox"
import { insertChat } from "@/lib/chat-store"

import { apiError, fakeModel } from "./fakes/fake-model"
import { fakeRunQueue } from "./fakes/fake-run-queue"
import { fakeSandbox } from "./fakes/fake-sandbox"
import { cleanupUser, createTestBot, testUserId } from "./helpers/db"
import { newChat, send } from "./helpers/runs"
import { signInAs, signOut } from "./helpers/session"

const owner = testUserId()
const stranger = testUserId()

let botId = ""
let strangerBotId = ""
let failedChat = ""
let failedUserMessage = ""
let busyChat = ""
let activeRunId = ""
let finishedRunId = ""
let groupChat = ""

// Everything the owner has, in a form that can be compared before and after.
async function ownersData() {
  const botRows = await db.select().from(bots).where(eq(bots.userId, owner))
  const chatRows = await db.select().from(chats).where(eq(chats.userId, owner))
  const chatIds = chatRows.map((chat) => chat.id)
  const [messageRows, runRows, memoryRows] = await Promise.all([
    db.select().from(messages).where(inArray(messages.chatId, chatIds)),
    db.select().from(runs).where(inArray(runs.chatId, chatIds)),
    db.select().from(botMemoryFiles).where(eq(botMemoryFiles.botId, botId)),
  ])

  const byId = <T extends { id: string }>(a: T, b: T) => a.id.localeCompare(b.id)
  return JSON.stringify({
    bots: botRows.sort(byId),
    chats: chatRows.sort(byId),
    messages: messageRows.sort(byId),
    runs: runRows.sort(byId),
    memory: memoryRows.sort((a, b) => a.path.localeCompare(b.path)),
  })
}

function request(method: string, url: string, body?: unknown) {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

const idParams = (id: string) => ({ params: Promise.resolve({ id }) })

// Every way in, as a function of who is calling. Each returns whether the
// answer was the same as for a thing that doesn't exist.
type Entry = { name: string; call: () => Promise<unknown>; looksMissing: (r: unknown) => boolean }

const hasError = (result: unknown) =>
  typeof result === "object" && result !== null && "error" in result
const isNull = (result: unknown) => result === null
const isStatus = (status: number) => (result: unknown) =>
  (result as Response).status === status

function entries(): Entry[] {
  return [
    { name: "open the chat page", call: () => loadChatPage(failedChat), looksMissing: isNull },
    { name: "open the bot (latest chat)", call: () => getOrCreateChatForBot(botId), looksMissing: isNull },
    { name: "start a chat with the bot", call: () => createChat(botId), looksMissing: hasError },
    {
      name: "start a group chat with the bot",
      call: () => createGroupChat({ name: "Mine now", botIds: [botId, strangerBotId] }),
      looksMissing: hasError,
    },
    { name: "delete the chat", call: () => deleteChat(failedChat), looksMissing: hasError },
    { name: "delete the chat that has a reply being written", call: () => deleteChat(busyChat), looksMissing: hasError },
    { name: "stop the run", call: () => stopRun(activeRunId), looksMissing: hasError },
    { name: "attach to the run", call: () => attachRun(activeRunId), looksMissing: isNull },
    {
      name: "read the run",
      call: () => getRun(request("GET", "http://t/api/runs/x"), idParams(activeRunId)),
      looksMissing: isStatus(404),
    },
    {
      name: "read a finished run",
      call: () => getRun(request("GET", "http://t/api/runs/x"), idParams(finishedRunId)),
      looksMissing: isStatus(404),
    },
    {
      name: "send a message",
      call: () => postChat(request("POST", "http://t/api/chat", { id: failedChat, text: "hi" })),
      looksMissing: isStatus(404),
    },
    {
      name: "retry a failed reply",
      call: () =>
        postChat(request("POST", "http://t/api/chat", { id: failedChat, retryOf: failedUserMessage })),
      looksMissing: isStatus(404),
    },
    { name: "read a memory file", call: () => readMemoryFile(botId, "notes.md"), looksMissing: hasError },
    {
      name: "overwrite a memory file",
      call: () => saveMemoryFile(botId, { path: "notes.md", content: "taken over", expectedVersion: 1 }),
      looksMissing: hasError,
    },
    {
      name: "add a memory file",
      call: () => saveMemoryFile(botId, { path: "new.md", content: "planted", expectedVersion: null }),
      looksMissing: hasError,
    },
    { name: "delete a memory file", call: () => deleteMemoryFile(botId, "notes.md"), looksMissing: hasError },
    { name: "reset the sandbox", call: () => resetSandbox(botId), looksMissing: hasError },
    {
      name: "see the screen's state",
      call: () => getScreen(request("GET", "http://t/api/bots/x/screen"), idParams(botId)),
      looksMissing: isStatus(404),
    },
    {
      name: "open the screen (and wake it)",
      call: () =>
        postScreen(
          request("POST", "http://t/api/bots/x/screen", { start: true, control: true }),
          idParams(botId)
        ),
      looksMissing: isStatus(404),
    },
    { name: "delete the bot", call: () => deleteBot(botId), looksMissing: hasError },
  ]
}

beforeAll(async () => {
  const bot = await createTestBot(owner)
  botId = bot.id
  strangerBotId = (await createTestBot(stranger)).id

  overrideProviders({
    runQueue: fakeRunQueue({ autoRun: false }),
    sandbox: fakeSandbox(),
  })

  // A chat whose reply failed, so it could be retried.
  failedChat = await newChat(owner, botId)
  const failed = await send(owner, failedChat, "A question")
  failedUserMessage = failed.userMessageId
  finishedRunId = failed.run.runId
  await executeRun(finishedRunId, {
    retryBaseMs: 20,
    progressIntervalMs: 50,
    model: fakeModel([{ error: apiError(400) }]),
  })

  // A chat with a reply that is still queued.
  busyChat = await newChat(owner, botId)
  activeRunId = (await send(owner, busyChat, "Another question")).run.runId

  groupChat =
    (await insertChat(owner, { botIds: [botId], title: "Group", group: true })) ?? ""

  // Memory and a sandbox, the other things that belong to the bot.
  await writeMemory(owner, botId, {
    path: "notes.md",
    content: "the owner's notes",
    expectedVersion: null,
  })
  await getOrCreateSandbox(owner, botId, { provider: fakeSandbox(), plan: "pro" })
})

afterEach(() => signOut())

afterAll(async () => {
  resetProviderOverrides()
  await Promise.all([owner, stranger].map(cleanupUser))
})

describe("another user's access to every resource", () => {
  it("has data to protect", async () => {
    expect(groupChat).not.toBe("")
    const data = JSON.parse(await ownersData())
    expect(data.chats.length).toBeGreaterThanOrEqual(3)
    expect(data.runs.map((r: { status: string }) => r.status).sort()).toEqual([
      "error",
      "queued",
    ])
    expect(data.memory).toHaveLength(1)
    expect(data.bots[0].sandboxId).toBeTruthy()
  })

  it("treats every one of the owner's things as missing, and changes none of them", async () => {
    const before = await ownersData()
    signInAs(stranger)

    for (const entry of entries()) {
      const result = await entry.call()
      expect(entry.looksMissing(result), `${entry.name}: ${JSON.stringify(result)?.slice(0, 200)}`).toBe(true)
    }

    // The stranger also has nothing new: no chat, no bot, no memory in their name.
    const theirChats = await db.select().from(chats).where(eq(chats.userId, stranger))
    expect(theirChats).toHaveLength(0)
    expect(await ownersData()).toBe(before)
  })

  it("gives nothing away in the answers, and no screen address or sandbox name", async () => {
    signInAs(stranger)
    const text = JSON.stringify(
      await Promise.all(
        entries().map(async (entry) => {
          const result = await entry.call()
          return result instanceof Response ? await result.text() : result
        })
      )
    )
    for (const secret of ["the owner's notes", "A question", "Another question", owner, botId]) {
      expect(text, secret).not.toContain(secret)
    }
    expect(text).not.toMatch(/sandbox_id|sandboxId|https?:\/\//i)
  })

  it("still works for the owner", async () => {
    signInAs(owner)
    expect((await readMemoryFile(botId, "notes.md")) as { file: { content: string } }).toMatchObject({
      file: { content: "the owner's notes" },
    })
    expect((await attachRun(activeRunId))?.snapshot).toMatchObject({ id: activeRunId })
    expect((await getRun(request("GET", "http://t/x"), idParams(activeRunId))).status).toBe(200)
    expect(await loadChatPage(failedChat)).not.toBeNull()
  })

  it("is refused to anyone who isn't signed in", async () => {
    const before = await ownersData()
    signOut()

    for (const entry of entries()) {
      let outcome: unknown
      try {
        outcome = await entry.call()
      } catch {
        // Pages ask Clerk to protect them, which throws when nobody is signed in.
        continue
      }
      const unauthorised =
        outcome === null ||
        hasError(outcome) ||
        [401, 404].includes((outcome as Response).status)
      expect(unauthorised, `${entry.name}: ${JSON.stringify(outcome)?.slice(0, 200)}`).toBe(true)
    }

    expect(await ownersData()).toBe(before)
  })
})
