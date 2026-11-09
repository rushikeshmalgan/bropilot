import {
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
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
