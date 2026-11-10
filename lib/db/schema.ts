import { sql } from "drizzle-orm"
import {
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import { nanoid } from "nanoid"

export const bots = pgTable(
  "bots",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => nanoid()),
    // Clerk user ID
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    // Seed for the bot's generated face
    avatar: text("avatar")
      .notNull()
      .$defaultFn(() => nanoid()),
    // What the bot is for, in a phrase
    job: text("job").notNull(),
    // How the bot should go about the job
    instructions: text("instructions"),
    // Third-party sandbox ID, created lazily after the bot exists
    sandboxId: text("sandbox_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("bots_user_id_idx").on(table.userId)]
)

export type Bot = typeof bots.$inferSelect
export type NewBot = typeof bots.$inferInsert

// A conversation. One-on-one chats have botId set; group chats leave it null.
// Either way every bot in the chat has a row in chat_bots.
export const chats = pgTable(
  "chats",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => nanoid()),
    // Clerk user ID
    userId: text("user_id").notNull(),
    botId: text("bot_id").references(() => bots.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("chats_user_id_idx").on(table.userId),
    index("chats_bot_id_idx").on(table.botId),
  ]
)

// Which bots take part in a chat.
export const chatBots = pgTable(
  "chat_bots",
  {
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    botId: text("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.chatId, table.botId] }),
    index("chat_bots_bot_id_idx").on(table.botId),
  ]
)

// One part of a message. Text only for now; tool calls and other part types
// can be added to this union without a schema change.
export type MessagePart = { type: "text"; text: string }

// Token counts for one model reply. A count is null when the provider didn't
// report it.
export type MessageUsage = {
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
}

export const messages = pgTable(
  "messages",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => nanoid()),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    role: text("role").$type<"user" | "assistant">().notNull(),
    // Which bot wrote it; null for the user's own messages.
    botId: text("bot_id").references(() => bots.id, { onDelete: "set null" }),
    parts: jsonb("parts").$type<MessagePart[]>().notNull(),
    status: text("status")
      .$type<"streaming" | "done" | "error">()
      .notNull()
      .default("done"),
    // Only set on assistant messages that came from a model call.
    usage: jsonb("usage").$type<MessageUsage>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("messages_chat_id_created_at_idx").on(table.chatId, table.createdAt)]
)

export type Chat = typeof chats.$inferSelect
export type Message = typeof messages.$inferSelect

// A run is one bot reply being produced in the background.
// - queued: saved and handed to the task queue
// - running: a worker is producing the reply
// - done / error / cancelled: finished; these never change again
export type RunStatus = "queued" | "running" | "done" | "error" | "cancelled"

export const ACTIVE_RUN_STATUSES = ["queued", "running"] as const

export const runs = pgTable(
  "runs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => nanoid()),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    botId: text("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    // The message this run answers.
    userMessageId: text("user_message_id").notNull(),
    // Chosen when the run is created, so a retried run writes to the same
    // message instead of adding a second one. The row itself is created when
    // the run starts.
    assistantMessageId: text("assistant_message_id").notNull(),
    // The task queue's own ID for this run (a Trigger.dev run ID).
    triggerRunId: text("trigger_run_id"),
    status: text("status").$type<RunStatus>().notNull().default("queued"),
    // A message that is safe to show the user; set when status is "error".
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    index("runs_chat_id_status_idx").on(table.chatId, table.status),
    // A chat has at most one unfinished run. The database enforces it, so two
    // sends at the same moment can't both start a reply.
    uniqueIndex("runs_one_active_per_chat_idx")
      .on(table.chatId)
      .where(sql`${table.status} in ('queued', 'running')`),
  ]
)

export type Run = typeof runs.$inferSelect
