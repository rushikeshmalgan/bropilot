// The real sandbox provider: Daytona.
//
// Written from the Daytona TypeScript SDK reference and its shipped type
// definitions (@daytonaio/sdk 0.231):
// - https://www.daytona.io/docs/en/typescript-sdk/daytona/ (create, get, delete)
// - https://www.daytona.io/docs/en/typescript-sdk/sandbox/ (start, stop, state)
// - https://www.daytona.io/docs/en/typescript-sdk/process/ (executeCommand)
// - https://www.daytona.io/docs/en/typescript-sdk/file-system/ (upload, download, list)
//
// The SDK is loaded the first time it is needed, so a server that never uses
// sandboxes doesn't pay for it. Only the fields below are ever sent when a
// sandbox is created: no environment variables, no secrets, no volumes.
import {
  SandboxProviderError,
  type CreateSandboxInput,
  type CreatedSandbox,
  type ExecOptions,
  type ExecResult,
  type SandboxEntry,
  type SandboxProvider,
  type SandboxState,
} from "@/lib/providers/sandbox"

type Sdk = typeof import("@daytonaio/sdk")
type DaytonaSandbox = import("@daytonaio/sdk").Sandbox

// Extra time the client waits on top of a command's own limit, so the
// server's timeout answers first.
const EXEC_CLIENT_GRACE_SECONDS = 10
const START_TIMEOUT_SECONDS = 60
// The longest any single request to the service may take. The SDK's own
// default is 24 hours; calls that carry their own limit (create, start,
// executeCommand) are bounded by that limit instead.
const REQUEST_TIMEOUT_MS = 60_000

// The label every sandbox this app makes carries, with the bot's ID.
export const BOT_LABEL = "bro-pilot-bot"

// Daytona's own state names, grouped by what the app needs to do about them.
const RUNNING = new Set(["started"])
const STOPPED = new Set(["stopped", "archived", "paused"])
const BROKEN = new Set(["error", "build_failed"])
const GONE = new Set(["destroyed", "destroying"])

function stateOf(raw: string | undefined): SandboxState {
  if (!raw) {
    return "transitioning"
  }
  if (RUNNING.has(raw)) {
    return "running"
  }
  if (STOPPED.has(raw)) {
    return "stopped"
  }
  if (BROKEN.has(raw)) {
    return "error"
  }
  if (GONE.has(raw)) {
    return "missing"
  }
  return "transitioning"
}

// Turns whatever the SDK threw into an error with a message that is safe to
// show. The SDK's own messages can contain URLs and internals, so they are
// logged by the caller's own handling and not passed on.
function toProviderError(error: unknown, fallback: string): SandboxProviderError {
  if (error instanceof SandboxProviderError) {
    return error
  }

  const status =
    typeof (error as { statusCode?: unknown })?.statusCode === "number"
      ? (error as { statusCode: number }).statusCode
      : undefined
  const name = error instanceof Error ? error.name : ""

  if (status === 404 || /NotFound/i.test(name)) {
    return new SandboxProviderError("That sandbox no longer exists.", "not_found")
  }
  if (status === 401 || status === 403) {
    return new SandboxProviderError(
      "The sandbox service rejected its API key."
    )
  }
  if (status === 429) {
    return new SandboxProviderError(
      "The sandbox service is busy. Try again in a minute."
    )
  }
  if (/Timeout/i.test(name) || status === 408) {
    return new SandboxProviderError("The sandbox took too long to respond.")
  }

  return new SandboxProviderError(fallback)
}

function isTimeout(error: unknown) {
  const name = error instanceof Error ? error.name : ""
  const message = error instanceof Error ? error.message : ""
  return /Timeout/i.test(name) || /timed? ?out|timeout/i.test(message)
}

export function daytonaProvider(apiKey: string): SandboxProvider {
  let client: Promise<InstanceType<Sdk["Daytona"]>> | null = null

  // One client for the process. Only the key is passed; the SDK reads
  // DAYTONA_API_URL and DAYTONA_TARGET from the environment itself if set.
  function daytona() {
    client ??= import("@daytonaio/sdk").then(
      (sdk) => new sdk.Daytona({ apiKey, requestTimeoutMs: REQUEST_TIMEOUT_MS })
    )
    return client
  }

  async function get(id: string): Promise<DaytonaSandbox> {
    try {
      return await (await daytona()).get(id)
    } catch (error) {
      throw toProviderError(error, "Couldn't reach the sandbox.")
    }
  }

  return {
    async create(input: CreateSandboxInput): Promise<CreatedSandbox> {
      try {
        const sandbox = await (
          await daytona()
        ).create(
          {
            labels: { [BOT_LABEL]: input.botId },
            // Switch itself off after this long without activity.
            autoStopInterval: input.autoStopMinutes,
            // Nothing else is set on purpose: no envVars, secrets or volumes.
          },
          { timeout: input.timeoutSeconds }
        )
        return { id: sandbox.id, user: sandbox.user }
      } catch (error) {
        console.error(
          "Couldn't create a sandbox:",
          error instanceof Error ? error.name : "unknown error"
        )
        throw toProviderError(error, "Couldn't create the sandbox.")
      }
    },

    async status(id) {
      try {
        const sandbox = await get(id)
        return stateOf(sandbox.state)
      } catch (error) {
        if (error instanceof SandboxProviderError && error.code === "not_found") {
          return "missing"
        }
        throw error
      }
    },

    async start(id) {
      const sandbox = await get(id)
      const state = stateOf(sandbox.state)
      if (state === "running") {
        return
      }
      if (state === "missing") {
        throw new SandboxProviderError(
          "That sandbox no longer exists.",
          "not_found"
        )
      }
      if (state === "error") {
        throw new SandboxProviderError(
          "The sandbox is in an error state. Reset it from the bot's settings."
        )
      }

      try {
        if (state === "stopped") {
          await sandbox.start(START_TIMEOUT_SECONDS)
        } else {
          await sandbox.waitUntilStarted(START_TIMEOUT_SECONDS)
        }
      } catch (error) {
        throw toProviderError(error, "Couldn't start the sandbox.")
      }
    },

    async stop(id) {
      const sandbox = await get(id)
      try {
        await sandbox.stop()
      } catch (error) {
        throw toProviderError(error, "Couldn't stop the sandbox.")
      }
    },

    async exec(id, command, options: ExecOptions): Promise<ExecResult> {
      const sandbox = await get(id)
      const clientDeadline = options.timeoutSeconds + EXEC_CLIENT_GRACE_SECONDS

      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const response = await Promise.race([
          // The command's own limit is enforced by the sandbox; no
          // environment is passed in.
          sandbox.process.executeCommand(
            command,
            undefined,
            undefined,
            options.timeoutSeconds
          ),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("client deadline timeout")),
              clientDeadline * 1000
            )
          }),
        ])

        return {
          exitCode: response.exitCode,
          output: response.result ?? response.artifacts?.stdout ?? "",
          timedOut: false,
        }
      } catch (error) {
        if (isTimeout(error)) {
          return { exitCode: 124, output: "", timedOut: true }
        }
        throw toProviderError(error, "The command couldn't be run.")
      } finally {
        clearTimeout(timer)
      }
    },

    async readFile(id, path, maxBytes) {
      const sandbox = await get(id)
      try {
        const details = await sandbox.fs.getFileDetails(path)
        if (details.isDir) {
          throw new SandboxProviderError(
            "That path is a folder. Use listFiles to see what is in it."
          )
        }
        if (details.size > maxBytes) {
          throw new SandboxProviderError(
            `That file is ${details.size} bytes and the limit is ${maxBytes}. Use bash to read part of it, for example with head.`
          )
        }
        return await sandbox.fs.downloadFile(path)
      } catch (error) {
        if (error instanceof SandboxProviderError) {
          throw error
        }
        if (error instanceof Error && /FileNotFound/i.test(error.name)) {
          throw new SandboxProviderError("That file doesn't exist.")
        }
        throw toProviderError(error, "Couldn't read that file.")
      }
    },

    async writeFile(id, path, content) {
      const sandbox = await get(id)
      try {
        await sandbox.fs.uploadFile(content, path)
      } catch (error) {
        throw toProviderError(error, "Couldn't write that file.")
      }
    },

    async list(id, path) {
      const sandbox = await get(id)
      try {
        const files = await sandbox.fs.listFiles(path)
        return files.map(
          (file): SandboxEntry => ({
            name: file.name,
            path: file.path ?? `${path.replace(/\/$/, "")}/${file.name}`,
            isDir: file.isDir,
            size: file.size,
          })
        )
      } catch (error) {
        if (error instanceof Error && /FileNotFound/i.test(error.name)) {
          throw new SandboxProviderError("That folder doesn't exist.")
        }
        throw toProviderError(error, "Couldn't list that folder.")
      }
    },

    async delete(id) {
      let sandbox: DaytonaSandbox
      try {
        sandbox = await get(id)
      } catch (error) {
        // Already gone is what the caller wanted.
        if (error instanceof SandboxProviderError && error.code === "not_found") {
          return
        }
        throw error
      }

      try {
        await sandbox.delete()
      } catch (error) {
        const mapped = toProviderError(error, "Couldn't delete the sandbox.")
        if (mapped.code === "not_found") {
          return
        }
        throw mapped
      }
    },

    async findByBot(botId) {
      try {
        const ids: string[] = []
        for await (const sandbox of (await daytona()).list({
          labels: { [BOT_LABEL]: botId },
        })) {
          ids.push(sandbox.id)
        }
        return ids
      } catch (error) {
        throw toProviderError(error, "Couldn't list sandboxes.")
      }
    },
  }
}
