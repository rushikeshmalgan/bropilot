// A bot's memory files. Every function takes the owner's user ID: a bot that
// belongs to someone else has no memory as far as the caller can tell.
//
// Saves use optimistic locking. A save says which version of the file it
// started from; if someone else (the bot in another chat, or the owner in the
// Memory tab) saved in between, it is refused instead of overwriting them.
import { and, asc, eq, sql } from "drizzle-orm"

import { db } from "@/lib/db"
import { botMemoryFiles, bots } from "@/lib/db/schema"

export const MEMORY_INDEX_PATH = "index.md"

export type MemoryLimits = {
  maxFiles: number                                          
  maxFileChars: number
}

export const MEMORY_LIMITS: MemoryLimits = {
  maxFiles: 50,
  maxFileChars: 20_000,
}

export const MAX_MEMORY_PATH_LENGTH = 120
const MAX_MEMORY_PATH_DEPTH = 4
// How much of index.md goes into the system prompt on every run.
export const MEMORY_INDEX_PROMPT_CHARS = 2000

export type MemoryFileInfo = {
  path: string
  version: number
  size: number
  updatedAt: Date
}

export type MemoryFile = {
  path: string
  content: string
  version: number
  updatedAt: Date
}

export type MemoryFailure = {
  ok: false
  code:
    | "not_found"
    | "invalid_path"
    | "too_large"
    | "too_many_files"
    | "conflict"
  // Safe to show the user, and short enough to hand to the model.
  error: string
  // For a conflict: the version the file has now (null if it was deleted).
  currentVersion?: number | null
}

export type MemoryWriteResult =
  | { ok: true; file: { path: string; version: number } }
  | MemoryFailure

// A memory path is a short relative path made of plain names: letters, digits,
// dots, dashes and underscores, each starting with a letter or digit. That
// rules out "..", absolute paths, backslashes, empty segments, hidden files
// and anything that could mean something to a file system or a URL.
export function normalizeMemoryPath(input: unknown): string | null {
  if (typeof input !== "string") {
    return null
  }

  const path = input.trim()
  if (!path || path.length > MAX_MEMORY_PATH_LENGTH) {
    return null
  }

  const segments = path.split("/")
  if (segments.length > MAX_MEMORY_PATH_DEPTH) {
    return null
  }
  for (const segment of segments) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment) || segment.includes("..")) {
      return null
    }
  }

  return path
}

const INVALID_PATH: MemoryFailure = {
  ok: false,
  code: "invalid_path",
  error:
    "That isn't a valid memory path. Use a short relative path such as notes.md or people/rushi.md.",
}

const NOT_FOUND: MemoryFailure = {
  ok: false,
  code: "not_found",
  error: "That memory file doesn't exist.",
}

function ownedBot(userId: string, botId: string) {
  return sql`exists (select 1 from bots where id = ${botId} and user_id = ${userId})`
}

async function ownsBot(userId: string, botId: string) {
  const [bot] = await db
    .select({ id: bots.id })
    .from(bots)
    .where(and(eq(bots.id, botId), eq(bots.userId, userId)))
    .limit(1)
  return Boolean(bot)
}

// The bot's files, without their contents. Null if the bot isn't the user's.
export async function listMemory(
  userId: string,
  botId: string
): Promise<MemoryFileInfo[] | null> {
  const [owned, files] = await Promise.all([
    ownsBot(userId, botId),
    db
      .select({
        path: botMemoryFiles.path,
        version: botMemoryFiles.version,
        size: sql<number>`char_length(${botMemoryFiles.content})`.mapWith(Number),
        updatedAt: botMemoryFiles.updatedAt,
      })
      .from(botMemoryFiles)
      .where(
        and(eq(botMemoryFiles.botId, botId), ownedBot(userId, botId))
      )
      .orderBy(asc(botMemoryFiles.path)),
  ])

  return owned ? files : null
}

export async function readMemory(
  userId: string,
  botId: string,
  rawPath: string
): Promise<MemoryFile | null> {
  const path = normalizeMemoryPath(rawPath)
  if (!path) {
    return null
  }

  const [file] = await db
    .select({
      path: botMemoryFiles.path,
      content: botMemoryFiles.content,
      version: botMemoryFiles.version,
      updatedAt: botMemoryFiles.updatedAt,
    })
    .from(botMemoryFiles)
    .where(
      and(
        eq(botMemoryFiles.botId, botId),
        eq(botMemoryFiles.path, path),
        ownedBot(userId, botId)
      )
    )
    .limit(1)

  return file ?? null
}

// Creates or updates a file.
// - expectedVersion null: create it; refused if it already exists.
// - expectedVersion N: update it; refused unless the file is still at version N.
export async function writeMemory(
  userId: string,
  botId: string,
  input: { path: string; content: string; expectedVersion: number | null },
  limits: MemoryLimits = MEMORY_LIMITS
): Promise<MemoryWriteResult> {
  const path = normalizeMemoryPath(input.path)
  if (!path) {
    return INVALID_PATH
  }
  if (typeof input.content !== "string") {
    return { ok: false, code: "too_large", error: "The content must be text." }
  }
  if (input.content.length > limits.maxFileChars) {
    return {
      ok: false,
      code: "too_large",
      error: `A memory file can hold up to ${limits.maxFileChars} characters. This one has ${input.content.length}.`,
    }
  }

  const conflict = async (): Promise<MemoryFailure> => {
    const current = await readMemory(userId, botId, path)
    if (!current && input.expectedVersion !== null) {
      // Deleted in the meantime, or never there.
      return (await ownsBot(userId, botId))
        ? {
            ok: false,
            code: "conflict",
            error: "That file no longer exists. Save it as a new file instead.",
            currentVersion: null,
          }
        : NOT_FOUND
    }
    return {
      ok: false,
      code: "conflict",
      error: current
        ? `That file has changed and is now at version ${current.version}. Read it again, then save with that version.`
        : "That file already exists.",
      currentVersion: current?.version ?? null,
    }
  }

  if (input.expectedVersion !== null) {
    const updated = await db
      .update(botMemoryFiles)
      .set({
        content: input.content,
        version: sql`${botMemoryFiles.version} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(botMemoryFiles.botId, botId),
          eq(botMemoryFiles.path, path),
          eq(botMemoryFiles.version, input.expectedVersion),
          ownedBot(userId, botId)
        )
      )
      .returning({ version: botMemoryFiles.version })

    return updated[0]
      ? { ok: true, file: { path, version: updated[0].version } }
      : conflict()
  }

  // A new file. The bot's row is locked for the length of this transaction, so
  // two creates at once are counted one after the other and the file limit
  // can't be passed.
  const [, inserted] = await db.batch([
    db.execute(
      sql`select id from bots where id = ${botId} and user_id = ${userId} for update`
    ),
    db.execute(sql`
      insert into bot_memory_files (bot_id, path, content)
      select ${botId}, ${path}, ${input.content}
      where ${ownedBot(userId, botId)}
        and (select count(*) from bot_memory_files where bot_id = ${botId}) < ${limits.maxFiles}
      on conflict (bot_id, path) do nothing
      returning version
    `),
  ])

  if (inserted.rows.length > 0) {
    return { ok: true, file: { path, version: 1 } }
  }

  // Nothing was inserted. Work out why.
  if (!(await ownsBot(userId, botId))) {
    return NOT_FOUND
  }
  if (await readMemory(userId, botId, path)) {
    return conflict()
  }
  return {
    ok: false,
    code: "too_many_files",
    error: `A bot can keep up to ${limits.maxFiles} memory files. Delete one first, or add to an existing file.`,
  }
}

// Deletes a file. With expectedVersion, only if it hasn't changed since.
export async function deleteMemory(
  userId: string,
  botId: string,
  rawPath: string,
  expectedVersion?: number
): Promise<{ ok: true } | MemoryFailure> {
  const path = normalizeMemoryPath(rawPath)
  if (!path) {
    return INVALID_PATH
  }

  const deleted = await db
    .delete(botMemoryFiles)
    .where(
      and(
        eq(botMemoryFiles.botId, botId),
        eq(botMemoryFiles.path, path),
        expectedVersion === undefined
          ? undefined
          : eq(botMemoryFiles.version, expectedVersion),
        ownedBot(userId, botId)
      )
    )
    .returning({ path: botMemoryFiles.path })

  if (deleted.length > 0) {
    return { ok: true }
  }

  const current = await readMemory(userId, botId, path)
  if (!current) {
    return NOT_FOUND
  }
  return {
    ok: false,
    code: "conflict",
    error: `That file has changed and is now at version ${current.version}.`,
    currentVersion: current.version,
  }
}

// The start of index.md, for the system prompt. Empty if the bot has none.
// The text is saved notes, so anything that looks like the wrapper it will be
// placed in is taken out: a note can't close the block and pose as a prompt.
export function memoryIndexForPrompt(content: string | null | undefined) {
  if (!content) {
    return ""
  }

  return content
    .replace(/<\/?memory-index>/gi, "")
    .slice(0, MEMORY_INDEX_PROMPT_CHARS)
    .trim()
}
