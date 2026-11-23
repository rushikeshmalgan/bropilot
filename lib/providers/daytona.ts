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
  type DesktopProvider,
  type DesktopState,
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
const GONE = new Set(["destroyed"])
const DELETING = new Set(["destroying"])

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
  if (DELETING.has(raw)) {
    return "deleting"
  }
  return "transitioning"
}

// The desktop service reports a status word. The SDK doesn't list the words,
// so unknown ones are treated as an error (and logged) rather than guessed at.
function desktopStateOf(raw: string | undefined): DesktopState {
  const word = (raw ?? "").toLowerCase()
  if (word === "active" || word === "running") {
    return "running"
  }
  if (word === "inactive" || word === "stopped" || word === "") {
    return "stopped"
  }
  if (word === "partial" || word === "starting") {
    return "starting"
  }

  console.error(`Unexpected desktop status word: ${word.slice(0, 40)}`)
  return "error"
}

// The width and height written in a PNG file's first chunk, or null if these
// bytes aren't a PNG.
export function pngSize(bytes: Buffer): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length < 24 || signature.some((byte, i) => bytes[i] !== byte)) {
    return null
  }

  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  return width > 0 && height > 0 ? { width, height } : null
}

// noVNC, the browser viewer the desktop serves.
const VIEWER_PORT = 6080
const VIEWER_PATH = "vnc.html"
// How long to wait for the desktop's processes to come up, and how often to look.
const DESKTOP_START_WAIT_MS = 45_000
const DESKTOP_POLL_MS = 1_500

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

export function daytonaProvider(
  apiKey: string,
  // A snapshot to make sandboxes from, for when the default has no desktop.
  options: { snapshot?: string } = {}
): SandboxProvider {
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

  // Waits for the desktop's processes to be up, looking now and then.
  async function waitForDesktop(sandbox: DaytonaSandbox) {
    const deadline = Date.now() + DESKTOP_START_WAIT_MS
    for (;;) {
      const status = await sandbox.computerUse.getStatus()
      const state = desktopStateOf(status.status)
      if (state === "running") {
        return
      }
      if (state === "error" || Date.now() > deadline) {
        throw new SandboxProviderError(
          "The desktop didn't start. If this keeps happening, the sandbox image may not include one."
        )
      }
      await new Promise((resolve) => setTimeout(resolve, DESKTOP_POLL_MS))
    }
  }

  const desktop: DesktopProvider = {
    async status(id) {
      const sandbox = await get(id)
      // A desktop only exists inside a running sandbox.
      if (stateOf(sandbox.state) !== "running") {
        return "stopped"
      }

      try {
        const status = await sandbox.computerUse.getStatus()
        return desktopStateOf(status.status)
      } catch (error) {
        throw toProviderError(error, "Couldn't check the desktop.")
      }
    },

    async start(id) {
      const sandbox = await get(id)
      try {
        const current = desktopStateOf(
          (await sandbox.computerUse.getStatus()).status
        )
        if (current === "running") {
          return
        }
        if (current !== "starting") {
          await sandbox.computerUse.start()
        }
        await waitForDesktop(sandbox)
      } catch (error) {
        throw toProviderError(error, "Couldn't start the desktop.")
      }
    },

    async screenshot(id) {
      const sandbox = await get(id)
      try {
        // PNG, so the size can be read from the file itself.
        const shot = await sandbox.computerUse.screenshot.takeCompressed({
          format: "png",
          showCursor: true,
        })
        const base64 = (shot.screenshot ?? "").replace(
          /^data:image\/png;base64,/,
          ""
        )
        const size = pngSize(Buffer.from(base64, "base64"))
        if (!size) {
          throw new SandboxProviderError(
            "The screen image wasn't in a format the app can read."
          )
        }
        return { base64, mediaType: "image/png", ...size }
      } catch (error) {
        throw toProviderError(error, "Couldn't take a screenshot.")
      }
    },

    async click(id, x, y, options) {
      const sandbox = await get(id)
      try {
        await sandbox.computerUse.mouse.click(
          x,
          y,
          options?.button ?? "left",
          options?.double ?? false
        )
      } catch (error) {
        throw toProviderError(error, "The click didn't work.")
      }
    },

    async move(id, x, y) {
      const sandbox = await get(id)
      try {
        await sandbox.computerUse.mouse.move(x, y)
      } catch (error) {
        throw toProviderError(error, "Couldn't move the pointer.")
      }
    },

    async type(id, text) {
      const sandbox = await get(id)
      try {
        await sandbox.computerUse.keyboard.type(text)
      } catch (error) {
        throw toProviderError(error, "Couldn't type that.")
      }
    },

    async press(id, key) {
      const sandbox = await get(id)
      try {
        await sandbox.computerUse.keyboard.press(key)
      } catch (error) {
        throw toProviderError(
          error,
          "That key wasn't accepted. Try a name like Return, Escape or Tab."
        )
      }
    },

    async scroll(id, x, y, direction, amount) {
      const sandbox = await get(id)
      try {
        await sandbox.computerUse.mouse.scroll(x, y, direction, amount)
      } catch (error) {
        throw toProviderError(error, "Couldn't scroll.")
      }
    },

    async viewerUrl(id, options) {
      const sandbox = await get(id)
      try {
        const signed = await sandbox.getSignedPreviewUrl(
          VIEWER_PORT,
          options.expiresInSeconds
        )

        // Build on the signed address rather than replacing it: wherever the
        // signature sits (host, path or query), it is kept.
        const url = new URL(signed.url)
        if (!url.pathname.endsWith(VIEWER_PATH)) {
          url.pathname = `${url.pathname.replace(/\/$/, "")}/${VIEWER_PATH}`
        }
        url.searchParams.set("autoconnect", "true")
        url.searchParams.set("resize", "scale")
        url.searchParams.set("view_only", options.viewOnly ? "true" : "false")
        return url.toString()
      } catch (error) {
        throw toProviderError(error, "Couldn't open the screen.")
      }
    },
  }

  return {
    desktop,
    async create(input: CreateSandboxInput): Promise<CreatedSandbox> {
      try {
        const sandbox = await (
          await daytona()
        ).create(
          {
            labels: { [BOT_LABEL]: input.botId },
            // Switch itself off after this long without activity.
            autoStopInterval: input.autoStopMinutes,
            // Only when one is configured; otherwise the default is used.
            ...(options.snapshot ? { snapshot: options.snapshot } : {}),
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
