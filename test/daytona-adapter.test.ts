import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { BOT_LABEL, daytonaProvider } from "@/lib/providers/daytona"
import { SandboxProviderError } from "@/lib/providers/sandbox"

// The Daytona SDK is replaced by a recorder, so these tests check exactly
// what the adapter sends and how it reads what comes back. They say nothing
// about the real service; scripts/smoke-daytona.ts does that.

class DaytonaError extends Error {
  statusCode?: number
  constructor(name: string, message: string, statusCode?: number) {
    super(message)
    this.name = name
    this.statusCode = statusCode
  }
}

const mock = vi.hoisted(() => ({
  config: undefined as unknown,
  creates: [] as { params: unknown; options: unknown }[],
  lists: [] as unknown[],
  sandboxes: new Map<string, unknown>(),
  createResult: undefined as unknown,
  listResult: [] as { id: string }[],
}))

vi.mock("@daytonaio/sdk", () => {
  class Daytona {
    constructor(config: unknown) {
      mock.config = config
    }

    async create(params: unknown, options: unknown) {
      mock.creates.push({ params, options })
      return mock.createResult
    }

    async get(id: string) {
      const sandbox = mock.sandboxes.get(id)
      if (!sandbox) {
        const error = new Error("Sandbox not found: internal-detail-xyz")
        error.name = "DaytonaNotFoundError"
        ;(error as { statusCode?: number }).statusCode = 404
        throw error
      }
      return sandbox
    }

    async *list(query: unknown) {
      mock.lists.push(query)
      for (const sandbox of mock.listResult) {
        yield sandbox
      }
    }
  }

  return { Daytona }
})

function sandbox(overrides: Record<string, unknown> = {}) {
  return {
    id: "sb-1",
    user: "daytona",
    state: "started",
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    waitUntilStarted: vi.fn(async () => {}),
    process: {
      executeCommand: vi.fn(async () => ({ exitCode: 0, result: "ok\n" })),
    },
    fs: {
      getFileDetails: vi.fn(async () => ({ isDir: false, size: 5 })),
      downloadFile: vi.fn(async () => Buffer.from("hello")),
      uploadFile: vi.fn(async () => {}),
      listFiles: vi.fn(async () => []),
    },
    ...overrides,
  }
}

describe("the Daytona adapter", () => {
  beforeEach(() => {
    mock.config = undefined
    mock.creates = []
    mock.lists = []
    mock.sandboxes = new Map()
    mock.createResult = sandbox()
    mock.listResult = []
    process.env.FAKE_SECRET_FOR_TEST = "s3cret-value-that-must-not-travel"
  })

  afterEach(() => {
    delete process.env.FAKE_SECRET_FOR_TEST
    vi.useRealTimers()
  })

  it("creates a sandbox with only a label, an auto-stop time and a timeout", async () => {
    const provider = daytonaProvider("test-key")

    const created = await provider.create({
      botId: "bot-1",
      autoStopMinutes: 10,
      timeoutSeconds: 60,
    })

    expect(created).toEqual({ id: "sb-1", user: "daytona" })
    // The client is given the key and a request time limit, nothing else.
    expect(mock.config).toEqual({ apiKey: "test-key", requestTimeoutMs: 60_000 })
    // What was sent: nothing that could carry a secret or reach the host.
    expect(mock.creates).toEqual([
      {
        params: {
          labels: { [BOT_LABEL]: "bot-1" },
          autoStopInterval: 10,
        },
        options: { timeout: 60 },
      },
    ])
    expect(JSON.stringify(mock.creates)).not.toContain("s3cret-value")
    const params = mock.creates[0].params as Record<string, unknown>
    for (const field of ["envVars", "secrets", "volumes", "public", "user"]) {
      expect(params, field).not.toHaveProperty(field)
    }
  })

  it("maps the provider's states to the app's", async () => {
    const provider = daytonaProvider("k")
    const states: Record<string, string> = {
      started: "running",
      stopped: "stopped",
      archived: "stopped",
      paused: "stopped",
      starting: "transitioning",
      stopping: "transitioning",
      creating: "transitioning",
      pulling_snapshot: "transitioning",
      error: "error",
      build_failed: "error",
      destroyed: "missing",
      destroying: "missing",
    }

    for (const [raw, expected] of Object.entries(states)) {
      mock.sandboxes.set("sb-1", sandbox({ state: raw }))
      expect(await provider.status("sb-1"), raw).toBe(expected)
    }
    expect(await provider.status("nope")).toBe("missing")
  })

  it("starts what is stopped, waits for what is starting, and refuses the rest", async () => {
    const provider = daytonaProvider("k")

    const stopped = sandbox({ state: "stopped" })
    mock.sandboxes.set("a", stopped)
    await provider.start("a")
    expect(stopped.start).toHaveBeenCalledOnce()

    const starting = sandbox({ state: "starting" })
    mock.sandboxes.set("b", starting)
    await provider.start("b")
    expect(starting.waitUntilStarted).toHaveBeenCalledOnce()
    expect(starting.start).not.toHaveBeenCalled()

    const running = sandbox()
    mock.sandboxes.set("c", running)
    await provider.start("c")
    expect(running.start).not.toHaveBeenCalled()

    mock.sandboxes.set("d", sandbox({ state: "error" }))
    await expect(provider.start("d")).rejects.toThrow(/error state/)
    mock.sandboxes.set("e", sandbox({ state: "destroyed" }))
    await expect(provider.start("e")).rejects.toMatchObject({ code: "not_found" })
    await expect(provider.start("nope")).rejects.toMatchObject({ code: "not_found" })
  })

  it("runs a command with a time limit and no environment", async () => {
    const provider = daytonaProvider("k")
    const box = sandbox()
    mock.sandboxes.set("sb-1", box)

    const result = await provider.exec("sb-1", "echo hi", { timeoutSeconds: 20 })

    expect(result).toEqual({ exitCode: 0, output: "ok\n", timedOut: false })
    // (command, working folder, environment, timeout): no folder, no environment.
    expect(box.process.executeCommand).toHaveBeenCalledWith(
      "echo hi",
      undefined,
      undefined,
      20
    )
  })

  it("reports a command that hit its limit, from the service or the client", async () => {
    const provider = daytonaProvider("k")

    const slowOnTheServer = sandbox({
      process: {
        executeCommand: vi.fn(async () => {
          throw new DaytonaError("DaytonaTimeoutError", "timed out", 408)
        }),
      },
    })
    mock.sandboxes.set("a", slowOnTheServer)
    expect(await provider.exec("a", "sleep 99", { timeoutSeconds: 5 })).toEqual({
      exitCode: 124,
      output: "",
      timedOut: true,
    })

    // The service never answers: the client gives up a little after the limit.
    vi.useFakeTimers()
    mock.sandboxes.set(
      "b",
      sandbox({
        process: { executeCommand: vi.fn(() => new Promise(() => {})) },
      })
    )
    const pending = provider.exec("b", "sleep 99", { timeoutSeconds: 5 })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(await pending).toMatchObject({ timedOut: true })
  })

  it("reads files within the size limit, and refuses the rest before downloading", async () => {
    const provider = daytonaProvider("k")
    const box = sandbox()
    mock.sandboxes.set("sb-1", box)

    expect((await provider.readFile("sb-1", "a.txt", 100)).toString()).toBe("hello")

    box.fs.getFileDetails.mockResolvedValueOnce({ isDir: false, size: 5000 })
    await expect(provider.readFile("sb-1", "big.bin", 100)).rejects.toThrow(/limit is 100/)
    expect(box.fs.downloadFile).toHaveBeenCalledTimes(1)

    box.fs.getFileDetails.mockResolvedValueOnce({ isDir: true, size: 0 })
    await expect(provider.readFile("sb-1", "dir", 100)).rejects.toThrow(/folder/)
    expect(box.fs.downloadFile).toHaveBeenCalledTimes(1)

    box.fs.getFileDetails.mockRejectedValueOnce(
      new DaytonaError("DaytonaFileNotFoundError", "no such file /secret/path")
    )
    await expect(provider.readFile("sb-1", "gone", 100)).rejects.toThrow(
      "That file doesn't exist."
    )
  })

  it("writes and lists files", async () => {
    const provider = daytonaProvider("k")
    const box = sandbox()
    mock.sandboxes.set("sb-1", box)

    await provider.writeFile("sb-1", "dir/a.txt", Buffer.from("data"))
    expect(box.fs.uploadFile).toHaveBeenCalledWith(Buffer.from("data"), "dir/a.txt")

    box.fs.listFiles.mockResolvedValueOnce([
      { name: "a.txt", path: "/home/daytona/dir/a.txt", isDir: false, size: 4 },
      { name: "sub", isDir: true, size: 0 },
    ] as never)
    expect(await provider.list("sb-1", "dir")).toEqual([
      { name: "a.txt", path: "/home/daytona/dir/a.txt", isDir: false, size: 4 },
      { name: "sub", path: "dir/sub", isDir: true, size: 0 },
    ])
  })

  it("deletes, treating a sandbox that is already gone as success", async () => {
    const provider = daytonaProvider("k")

    const box = sandbox()
    mock.sandboxes.set("sb-1", box)
    await provider.delete("sb-1")
    expect(box.delete).toHaveBeenCalledOnce()

    await expect(provider.delete("never-existed")).resolves.toBeUndefined()

    mock.sandboxes.set(
      "raced",
      sandbox({
        delete: vi.fn(async () => {
          throw new DaytonaError("DaytonaNotFoundError", "gone", 404)
        }),
      })
    )
    await expect(provider.delete("raced")).resolves.toBeUndefined()

    mock.sandboxes.set(
      "stuck",
      sandbox({
        delete: vi.fn(async () => {
          throw new DaytonaError("DaytonaInternalServerError", "boom", 500)
        }),
      })
    )
    await expect(provider.delete("stuck")).rejects.toBeInstanceOf(SandboxProviderError)
  })

  it("finds a bot's sandboxes by label", async () => {
    const provider = daytonaProvider("k")
    mock.listResult = [{ id: "x" }, { id: "y" }]

    expect(await provider.findByBot("bot-9")).toEqual(["x", "y"])
    expect(mock.lists).toEqual([{ labels: { [BOT_LABEL]: "bot-9" } }])
  })

  it("never passes the service's own error text on", async () => {
    const provider = daytonaProvider("k")
    const leaky = (name: string, status?: number) =>
      sandbox({
        process: {
          executeCommand: vi.fn(async () => {
            throw new DaytonaError(
              name,
              "POST https://app.daytona.io/api/x failed: Bearer sk-live-abc123",
              status
            )
          }),
        },
      })

    const cases: [string, number | undefined, RegExp][] = [
      ["DaytonaAuthenticationError", 401, /rejected its API key/],
      ["DaytonaRateLimitError", 429, /busy/],
      ["DaytonaInternalServerError", 500, /couldn't be run/],
      ["Error", undefined, /couldn't be run/],
    ]
    for (const [name, status, expected] of cases) {
      mock.sandboxes.set("sb-1", leaky(name, status))
      const error = await provider
        .exec("sb-1", "echo", { timeoutSeconds: 5 })
        .catch((caught: unknown) => caught)
      expect(error, name).toBeInstanceOf(SandboxProviderError)
      expect((error as Error).message, name).toMatch(expected)
      expect((error as Error).message, name).not.toContain("sk-live")
      expect((error as Error).message, name).not.toContain("daytona.io")
    }
  })
})
