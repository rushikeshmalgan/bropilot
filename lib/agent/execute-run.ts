// Produces one bot reply. The Trigger.dev task calls this, and so does the
// fake runner in tests; neither holds any logic of its own.
//
// executeRun can be called more than once for the same run (a task retry). It
// always writes to the run's own assistant message, so a retry replaces the
// reply instead of adding a second one, and a run that already finished is
// left alone.
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm"
import type { LanguageModel } from "ai"

import {
  BUSY_MESSAGE,
  GENERIC_ERROR_MESSAGE,
  MAX_HISTORY_MESSAGES,
  MAX_RATE_LIMIT_ATTEMPTS,
  MAX_RUN_DURATION_MS,
  MODEL_RETRY_BASE_MS,
  OUT_OF_STEPS_MESSAGE,
  RUN_PROGRESS_INTERVAL_MS,
  RUN_TIMEOUT_MESSAGE,
  classifyModelError,
  describeModelError,
  findStatusCode,
} from "@/lib/ai"
import { runModel } from "@/lib/agent/run-model"
import { failRun } from "@/lib/agent/run-store"
import { buildTools } from "@/lib/agent/tools"
import {
  MAX_TOOL_OUTPUT_CHARS,
  isToolFailure,
} from "@/lib/agent/tools/shared"
import { textOfParts, type RunProgress } from "@/lib/chat-types"
import { db } from "@/lib/db"
import {
  botMemoryFiles,
  bots,
  chatBots,
  chats,
  messages,
  runs,
  type MessagePart,
  type MessageUsage,
  type Run,
  type RunStatus,
  type ToolPart,
} from "@/lib/db/schema"
import { MEMORY_INDEX_PATH, memoryIndexForPrompt } from "@/lib/memory"
import type { HostLookup } from "@/lib/net/url-safety"
import { isPlanId } from "@/lib/plans"
import { newMeter, recordRunUsage, type RunMeter } from "@/lib/usage"

export type ExecuteRunDeps = {
  model?: LanguageModel
  // Waits between retries. Tests pass shorter delays; they are still real.
  retryBaseMs?: number
  progressIntervalMs?: number
  maxDurationMs?: number
  // Resolves host names for the URL safety check in web tools.
  hostLookup?: HostLookup
  // Called with the reply so far each time it is saved, and once at the end.
  onProgress?: (progress: RunProgress) => void
}

export type ExecuteRunResult = {
  // "missing" means there is no such run (its chat was probably deleted).
  status: RunStatus | "missing"
}

type Attempt =
  | { kind: "ok"; parts: MessagePart[]; usage: MessageUsage | null }
  // The run was stopped or its chat deleted; nothing more may be written.
  | { kind: "stopped" }
  | { kind: "timeout" }
  | { kind: "error"; error: unknown }

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// A line for the server log that can't contain message text or keys.
function describeForLog(error: unknown) {
  const name = error instanceof Error ? error.name : typeof error
  const status = findStatusCode(error)
  return `${name}${status ? ` (HTTP ${status})` : ""}`
}

// The token counts for a finished reply, or null if the provider gave none.
async function readUsage(result: {
  totalUsage: PromiseLike<{
    inputTokens: number | undefined
    outputTokens: number | undefined
    totalTokens: number | undefined
  }>
}): Promise<MessageUsage | null> {
  try {
    const usage = await result.totalUsage
    return {
      inputTokens: usage.inputTokens ?? null,
      outputTokens: usage.outputTokens ?? null,
      totalTokens: usage.totalTokens ?? null,
    }
  } catch {
    return null
  }
}

// Tools cap their own output. This is a backstop for what gets saved, in case
// one ever doesn't: a message row must stay small.
function forStorage(output: unknown): unknown {
  let serialized: string
  try {
    serialized = JSON.stringify(output) ?? "null"
  } catch {
    return { error: "The tool's output couldn't be saved." }
  }

  if (serialized.length <= MAX_TOOL_OUTPUT_CHARS * 2) {
    return output
  }
  return {
    truncated: true,
    preview: serialized.slice(0, MAX_TOOL_OUTPUT_CHARS),
  }
}

// A screenshot goes to the model and nowhere else: it is big, and it can show
// anything. What is saved says an image was taken.
function withoutImage(output: unknown): unknown {
  if (
    typeof output === "object" &&
    output !== null &&
    typeof (output as { image?: unknown }).image === "string"
  ) {
    return { ...output, image: "(screenshot not saved)" }
  }
  return output
}

// Collects the reply as it streams in: text and tool calls, in order.
class ReplyBuilder {
  parts: MessagePart[] = []

  addText(text: string) {
    const last = this.parts[this.parts.length - 1]
    if (last?.type === "text") {
      last.text += text
    } else {
      this.parts.push({ type: "text", text })
    }
  }

  startTool(id: string, name: string, input: unknown) {
    if (!this.tool(id)) {
      this.parts.push({ type: "tool", id, name, input, state: "running" })
    }
  }

  // A tool that returns { error } has failed, even though it didn't throw.
  finishTool(id: string, output: unknown) {
    const part = this.tool(id)
    if (part) {
      part.output = forStorage(withoutImage(output))
      part.state = isToolFailure(output) ? "error" : "done"
    }
  }

  failTool(id: string, message: string) {
    const part = this.tool(id)
    if (part) {
      part.output = { error: message }
      part.state = "error"
    }
  }

  private tool(id: string): ToolPart | undefined {
    return this.parts.find(
      (part): part is ToolPart => part.type === "tool" && part.id === id
    )
  }

  snapshot(): MessagePart[] {
    return this.parts.map((part) => ({ ...part }))
  }
}

async function isRunning(runId: string) {
  const [row] = await db
    .select({ status: runs.status })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1)

  return row?.status === "running"
}

// Saves the reply so far, but only while the run is still running. Returns
// false once the run was stopped, timed out or deleted, which tells the caller
// to stop working.
async function saveProgress(run: Run, parts: MessagePart[]) {
  const saved = await db
    .update(messages)
    .set({ parts })
    .where(
      and(
        eq(messages.id, run.assistantMessageId),
        sql`exists (select 1 from runs r where r.id = ${run.id} and r.status = 'running')`
      )
    )
    .returning({ id: messages.id })

  return saved.length > 0
}

// Creates the run's assistant message, or empties it if an earlier attempt
// left one behind. Returns false if the run is no longer running.
async function openAssistantMessage(run: Run) {
  const result = await db.execute(sql`
    insert into messages (id, chat_id, role, bot_id, parts, status)
    select ${run.assistantMessageId}, ${run.chatId}, 'assistant', ${run.botId}, '[]'::jsonb, 'streaming'
    where exists (select 1 from runs where id = ${run.id} and status = 'running')
    on conflict (id) do update set parts = '[]'::jsonb, status = 'streaming'
    returning id
  `)

  return result.rows.length > 0
}

// Everything the model needs, read fresh from the database.
async function loadContext(run: Run) {
  const [chatRows, participants, recent, indexRows] = await Promise.all([
    db.select().from(chats).where(eq(chats.id, run.chatId)).limit(1),
    db
      .select({
        id: bots.id,
        name: bots.name,
        job: bots.job,
        instructions: bots.instructions,
      })
      .from(chatBots)
      .innerJoin(bots, eq(bots.id, chatBots.botId))
      .where(eq(chatBots.chatId, run.chatId)),
    db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.chatId, run.chatId),
          eq(messages.status, "done"),
          ne(messages.id, run.assistantMessageId)
        )
      )
      .orderBy(desc(messages.createdAt))
      .limit(MAX_HISTORY_MESSAGES),
    // The answering bot's memory index, shown to it on every run.
    db
      .select({ content: botMemoryFiles.content })
      .from(botMemoryFiles)
      .where(
        and(
          eq(botMemoryFiles.botId, run.botId),
          eq(botMemoryFiles.path, MEMORY_INDEX_PATH)
        )
      )
      .limit(1),
  ])

  const chat = chatRows[0]
  const bot = participants.find((member) => member.id === run.botId)
  if (!chat || !bot) {
    return null
  }

  return {
    chat,
    bot,
    participants,
    history: recent.reverse(),
    memoryIndex: memoryIndexForPrompt(indexRows[0]?.content),
  }
}

export async function executeRun(
  runId: string,
  deps: ExecuteRunDeps = {}
): Promise<ExecuteRunResult> {
  const meter = newMeter()
  const result = await runOnce(runId, deps, meter)

  // Add the reply's tokens and sandbox time to the month's usage. It does
  // nothing for a run that isn't finished, and counts a finished one only once
  // however many times this is called.
  if (result.status !== "missing") {
    try {
      await recordRunUsage(runId, meter)
    } catch (error) {
      console.error(
        "Couldn't record a run's usage:",
        error instanceof Error ? error.name : "unknown error"
      )
    }
  }

  return result
}

async function runOnce(
  runId: string,
  deps: ExecuteRunDeps,
  meter: RunMeter
): Promise<ExecuteRunResult> {
  if (typeof runId !== "string" || !runId) {
    return { status: "missing" }
  }

  const retryBaseMs = deps.retryBaseMs ?? MODEL_RETRY_BASE_MS
  const progressIntervalMs = deps.progressIntervalMs ?? RUN_PROGRESS_INTERVAL_MS
  const maxDurationMs = deps.maxDurationMs ?? MAX_RUN_DURATION_MS

  // Take the run. A queued run starts now; a run that was already running is a
  // retry and keeps its original start time, so retries can't extend the
  // deadline. A finished run is left exactly as it is.
  const [run] = await db
    .update(runs)
    .set({ status: "running", startedAt: sql`coalesce(${runs.startedAt}, now())` })
    .where(and(eq(runs.id, runId), inArray(runs.status, ["queued", "running"])))
    .returning()

  if (!run) {
    const [existing] = await db
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1)
    return { status: existing?.status ?? "missing" }
  }

  const deadline = (run.startedAt ?? new Date()).getTime() + maxDurationMs
  let seq = 0
  const publish = (parts: MessagePart[]) => {
    try {
      deps.onProgress?.({ seq: ++seq, parts })
    } catch {
      // Live updates are a convenience; the database is what counts.
    }
  }

  const fail = async (message: string): Promise<ExecuteRunResult> => {
    await failRun(run, message)
    return currentStatus()
  }

  const currentStatus = async (): Promise<ExecuteRunResult> => {
    const [row] = await db
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, run.id))
      .limit(1)
    return { status: row?.status ?? "missing" }
  }

  const context = await loadContext(run)
  if (!context) {
    return fail(GENERIC_ERROR_MESSAGE)
  }

  if (!(await openAssistantMessage(run))) {
    return currentStatus()
  }

  // The tools this bot has for this run. Who they act for comes from the
  // database, never from the model.
  const { tools, capabilities } = buildTools({
    userId: context.chat.userId,
    botId: run.botId,
    runId: run.id,
    // The plan the user was on when they sent the message.
    plan: isPlanId(run.plan) ? run.plan : "free",
    meter,
    hostLookup: deps.hostLookup,
  })

  // One model call, streamed into the assistant message.
  const attemptOnce = async (): Promise<Attempt> => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      return { kind: "timeout" }
    }

    const controller = new AbortController()
    const reply = new ReplyBuilder()
    let stopped = false
    let timedOut = false
    let dirty = false
    let streamError: unknown
    let inFlight: Promise<void> | null = null

    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, remaining)

    // Once per interval: save new text if there is any, otherwise just check
    // that the run hasn't been stopped. Either way a stop is noticed quickly.
    const tick = setInterval(() => {
      if (inFlight) {
        return
      }

      inFlight = (async () => {
        try {
          let alive: boolean
          if (dirty) {
            dirty = false
            const parts = reply.snapshot()
            alive = await saveProgress(run, parts)
            if (alive) {
              publish(parts)
            }
          } else {
            alive = await isRunning(run.id)
          }

          if (!alive) {
            stopped = true
            controller.abort()
          }
        } catch {
          // A failed progress write is retried on the next tick.
        } finally {
          inFlight = null
        }
      })()
    }, progressIntervalMs)

    try {
      const result = runModel({
        bot: context.bot,
        chatBots: context.participants,
        isGroup: context.chat.botId === null,
        history: context.history,
        model: deps.model,
        tools,
        capabilities,
        memoryIndex: context.memoryIndex,
        abortSignal: controller.signal,
      })

      for await (const part of result.fullStream) {
        if (stopped || timedOut) {
          break
        }
        if (part.type === "text-delta") {
          reply.addText(part.text)
          dirty = true
        } else if (part.type === "tool-call") {
          reply.startTool(part.toolCallId, part.toolName, part.input)
          dirty = true
        } else if (part.type === "tool-result") {
          reply.finishTool(part.toolCallId, part.output)
          dirty = true
        } else if (part.type === "tool-error") {
          // The tool threw, or the model sent input the tool doesn't accept.
          // The model is told, and the run carries on.
          reply.failTool(part.toolCallId, "The tool call failed.")
          dirty = true
        } else if (part.type === "error") {
          streamError = part.error
          break
        }
      }

      if (stopped) {
        return { kind: "stopped" }
      }
      if (timedOut) {
        return { kind: "timeout" }
      }
      if (streamError !== undefined) {
        return { kind: "error", error: streamError }
      }

      return {
        kind: "ok",
        parts: reply.snapshot(),
        usage: await readUsage(result),
      }
    } catch (error) {
      if (stopped) {
        return { kind: "stopped" }
      }
      if (timedOut) {
        return { kind: "timeout" }
      }
      return { kind: "error", error: streamError ?? error }
    } finally {
      clearInterval(tick)
      clearTimeout(timeout)
      // Let a write that is already on its way finish before anything else is
      // written, so an old snapshot can't land on top of a newer one.
      await inFlight
    }
  }

  let attempts = 0
  let retriedOnce = false

  for (;;) {
    attempts++
    const attempt = await attemptOnce()

    if (attempt.kind === "stopped") {
      return currentStatus()
    }

    if (attempt.kind === "timeout") {
      return fail(RUN_TIMEOUT_MESSAGE)
    }

    if (attempt.kind === "ok") {
      if (!textOfParts(attempt.parts).trim()) {
        if (!attempt.parts.some((part) => part.type === "tool")) {
          console.error(`Run ${run.id}: the model returned an empty reply`)
          return fail(GENERIC_ERROR_MESSAGE)
        }
        // It called tools until the step limit and never got to answer. Keep
        // what the tools found and say what happened.
        attempt.parts.push({ type: "text", text: OUT_OF_STEPS_MESSAGE })
      }

      meter.inputTokens += attempt.usage?.inputTokens ?? 0
      meter.outputTokens += attempt.usage?.outputTokens ?? 0

      // The run and its message finish together, and only if the run is still
      // running: a Stop that got there first wins and this changes nothing.
      const finished = sql`exists (select 1 from runs r where r.id = ${run.id} and r.status = 'done')`
      await db.batch([
        db
          .update(runs)
          .set({ status: "done", finishedAt: new Date() })
          .where(and(eq(runs.id, run.id), eq(runs.status, "running"))),
        db
          .update(messages)
          .set({ parts: attempt.parts, usage: attempt.usage, status: "done" })
          .where(and(eq(messages.id, run.assistantMessageId), finished)),
        db
          .update(chats)
          .set({ updatedAt: new Date() })
          .where(and(eq(chats.id, run.chatId), finished)),
      ])

      publish(attempt.parts)
      return currentStatus()
    }

    // The model call failed. Decide whether another try is worth it.
    const kind = classifyModelError(attempt.error)
    console.error(
      `Run ${run.id}: model call ${attempts} failed: ${describeForLog(attempt.error)}`
    )

    let delay: number | null = null
    if (kind === "rate_limit" && attempts < MAX_RATE_LIMIT_ATTEMPTS) {
      // Exponential backoff: the base, then twice the base.
      delay = retryBaseMs * 2 ** (attempts - 1)
    } else if (
      kind === "retry_once" &&
      !retriedOnce &&
      attempts < MAX_RATE_LIMIT_ATTEMPTS
    ) {
      retriedOnce = true
      delay = retryBaseMs / 4
    }

    if (delay === null) {
      return fail(
        kind === "rate_limit" ? BUSY_MESSAGE : describeModelError(attempt.error)
      )
    }
    if (Date.now() + delay >= deadline) {
      return fail(kind === "rate_limit" ? BUSY_MESSAGE : RUN_TIMEOUT_MESSAGE)
    }

    await sleep(delay)

    // Start the reply again from nothing. If the run was stopped while we
    // waited, this write is refused and we stop too.
    if (!(await saveProgress(run, []))) {
      return currentStatus()
    }
    publish([])
  }
}
