// Sandbox tools: a small Linux computer that belongs to the bot. The sandbox
// is made the first time one of these tools is used, never before. Who it
// belongs to is fixed by the run; the model only supplies commands and paths.
import { tool } from "ai"
import { z } from "zod"

import {
  MAX_TOOL_OUTPUT_CHARS,
  UNTRUSTED_NOTE,
  clip,
  toolFailure,
  type ToolContext,
} from "@/lib/agent/tools/shared"
import { getOrCreateSandbox } from "@/lib/sandbox"
import { getSandboxProvider } from "@/lib/providers"
import { cleanText, safeSlice } from "@/lib/text"
import type { SandboxProvider } from "@/lib/providers/sandbox"

export const MAX_COMMAND_CHARS = 4000
export const DEFAULT_COMMAND_SECONDS = 30
export const MAX_COMMAND_SECONDS = 120
// All the sandbox time one reply may use, across every command.
export const MAX_SANDBOX_SECONDS_PER_RUN = 90
export const MAX_PATH_CHARS = 500
// The largest file readFile will open, and writeFile will save.
export const MAX_FILE_BYTES = 100_000
export const MAX_LIST_ENTRIES = 100

// Keeps the start and the end of long output: build logs and test runs say
// the important thing last.
export function clipMiddle(raw: string, max: number) {
  // Command output can hold NUL characters, which can't be saved.
  const text = cleanText(raw)
  if (text.length <= max) {
    return { text, truncated: false }
  }

  const tail = Math.floor(max / 4)
  const head = max - tail
  const cut = text.length - max
  return {
    text: cleanText(
      `${safeSlice(text, head)}\n…[${cut} characters cut]…\n${text.slice(text.length - tail)}`
    ),
    truncated: true,
  }
}

function validPath(path: string) {
  return path.length > 0 && path.length <= MAX_PATH_CHARS && !path.includes("\0")
}

const pathSchema = z
  .string()
  .min(1)
  .max(MAX_PATH_CHARS)
  .describe("A path in the sandbox: absolute, or relative to its home folder")

export function sandboxTools(
  context: ToolContext,
  providerOverride?: SandboxProvider,
  // Tests shorten the per-reply time budget; the app uses the default.
  limits: { secondsPerRun?: number } = {}
) {
  // The time this reply has left for commands, shared by every call.
  let secondsLeft = limits.secondsPerRun ?? MAX_SANDBOX_SECONDS_PER_RUN

  // The sandbox for this bot, made now if it doesn't exist yet.
  async function sandbox() {
    const provider = providerOverride ?? getSandboxProvider()
    if (!provider) {
      return { error: "Sandboxes aren't available right now." } as const
    }

    const found = await getOrCreateSandbox(context.userId, context.botId, {
      provider,
      plan: context.plan,
    })
    return found.ok
      ? ({ provider, id: found.sandboxId } as const)
      : ({ error: found.error } as const)
  }

  return {
    bash: tool({
      description: `Run a shell command in your own Linux sandbox (a small computer only you use; files stay between chats). Output is cut if long. Each command may take up to ${MAX_COMMAND_SECONDS} seconds, and one reply has ${MAX_SANDBOX_SECONDS_PER_RUN} seconds of sandbox time in total. It is not the user's computer.`,
      inputSchema: z.object({
        command: z
          .string()
          .min(1)
          .max(MAX_COMMAND_CHARS)
          .describe("The command, run with bash"),
        timeoutSeconds: z
          .number()
          .int()
          .min(1)
          .max(MAX_COMMAND_SECONDS)
          .optional()
          .describe(`Stop it after this long. Default ${DEFAULT_COMMAND_SECONDS}`),
      }),
      execute: async ({ command, timeoutSeconds }) => {
        // The time is taken before anything is awaited, so commands started at
        // the same moment can't each spend the whole budget. What a command
        // doesn't use is given back at the end.
        let limit = 0
        let used = 0
        try {
          if (secondsLeft <= 0) {
            return {
              error:
                "This reply has used all of its sandbox time. Say what you found so far, and carry on in the next message.",
            }
          }

          limit = Math.min(
            timeoutSeconds ?? DEFAULT_COMMAND_SECONDS,
            MAX_COMMAND_SECONDS,
            secondsLeft
          )
          secondsLeft -= limit

          const ready = await sandbox()
          if ("error" in ready) {
            return { error: ready.error }
          }

          const started = Date.now()
          // No environment is passed in: nothing from this server's
          // configuration can reach the sandbox.
          const result = await ready.provider.exec(ready.id, command, {
            timeoutSeconds: limit,
          })
          const elapsed = Math.max(1, Math.ceil((Date.now() - started) / 1000))
          used = Math.min(limit, elapsed)
          if (context.meter) {
            context.meter.sandboxSeconds += elapsed
          }

          const output = clipMiddle(result.output, MAX_TOOL_OUTPUT_CHARS)
          return {
            exitCode: result.exitCode,
            output: output.text,
            truncated: output.truncated,
            timedOut: result.timedOut,
            ...(result.timedOut
              ? { note: `The command was stopped after ${limit} seconds.` }
              : {}),
            untrusted: UNTRUSTED_NOTE,
          }
        } catch (error) {
          return toolFailure(error, "The command couldn't be run.")
        } finally {
          // Give back the time that was reserved but not used.
          secondsLeft += Math.max(0, limit - used)
        }
      },
    }),

    readFile: tool({
      description: `Read a text file in your sandbox. Files over ${MAX_FILE_BYTES} bytes are refused; use bash (head, grep) for those.`,
      inputSchema: z.object({ path: pathSchema }),
      execute: async ({ path }) => {
        try {
          if (!validPath(path)) {
            return { error: "That isn't a valid path." }
          }

          const ready = await sandbox()
          if ("error" in ready) {
            return { error: ready.error }
          }

          const bytes = await ready.provider.readFile(
            ready.id,
            path,
            MAX_FILE_BYTES
          )
          if (bytes.includes(0)) {
            return {
              error: "That looks like a binary file, so it can't be shown as text.",
            }
          }

          const content = clip(bytes.toString("utf8"), MAX_TOOL_OUTPUT_CHARS)
          return {
            path,
            content: content.text,
            truncated: content.truncated,
            untrusted: UNTRUSTED_NOTE,
          }
        } catch (error) {
          return toolFailure(error, "Couldn't read that file.")
        }
      },
    }),

    writeFile: tool({
      description: `Save a text file in your sandbox, replacing it if it exists. Up to ${MAX_FILE_BYTES} bytes.`,
      inputSchema: z.object({
        path: pathSchema,
        content: z.string().describe("The whole file"),
      }),
      execute: async ({ path, content }) => {
        try {
          if (!validPath(path)) {
            return { error: "That isn't a valid path." }
          }

          const bytes = Buffer.from(content, "utf8")
          if (bytes.length > MAX_FILE_BYTES) {
            return {
              error: `That file is ${bytes.length} bytes and the limit is ${MAX_FILE_BYTES}.`,
            }
          }

          const ready = await sandbox()
          if ("error" in ready) {
            return { error: ready.error }
          }

          await ready.provider.writeFile(ready.id, path, bytes)
          return { saved: path, bytes: bytes.length }
        } catch (error) {
          return toolFailure(error, "Couldn't save that file.")
        }
      },
    }),

    listFiles: tool({
      description: `List the files and folders in a folder of your sandbox (up to ${MAX_LIST_ENTRIES}).`,
      inputSchema: z.object({
        path: pathSchema
          .optional()
          .describe("The folder. Default: the sandbox's home folder"),
      }),
      execute: async ({ path }) => {
        try {
          const folder = path ?? "."
          if (!validPath(folder)) {
            return { error: "That isn't a valid path." }
          }

          const ready = await sandbox()
          if ("error" in ready) {
            return { error: ready.error }
          }

          const entries = await ready.provider.list(ready.id, folder)
          return {
            path: folder,
            entries: entries.slice(0, MAX_LIST_ENTRIES).map((entry) => ({
              name: entry.name.slice(0, 200),
              type: entry.isDir ? "folder" : "file",
              size: entry.size,
            })),
            truncated: entries.length > MAX_LIST_ENTRIES,
          }
        } catch (error) {
          return toolFailure(error, "Couldn't list that folder.")
        }
      },
    }),
  }
}
