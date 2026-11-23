import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { BOT_LABEL, daytonaProvider, pngSize } from "@/lib/providers/daytona"
import { getSandboxProvider } from "@/lib/providers"
import { SandboxProviderError } from "@/lib/providers/sandbox"

import { fakePng } from "./fakes/fake-sandbox"

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
    computerUse: {
      getStatus: vi.fn(async () => ({ status: "active" })),
      start: vi.fn(async () => ({})),
      screenshot: {
        takeCompressed: vi.fn(async () => ({ screenshot: fakePng(1280, 720) })),
      },
      mouse: {
        click: vi.fn(async () => ({})),
        move: vi.fn(async () => ({})),
        scroll: vi.fn(async () => true),
      },
      keyboard: {
        type: vi.fn(async () => {}),
        press: vi.fn(async () => {}),
      },
    },
    getSignedPreviewUrl: vi.fn(async () => ({
      url: "https://6080-sb-1.proxy.example.invalid/",
      token: "t",
      port: 6080,
      sandboxId: "sb-1",
    })),
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
      destroying: "deleting",
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

describe("the Daytona adapter's desktop", () => {
  beforeEach(() => {
    mock.config = undefined
    mock.creates = []
    mock.sandboxes = new Map()
    mock.createResult = sandbox()
  })

  afterEach(() => {
    delete process.env.DAYTONA_API_KEY
    delete process.env.DAYTONA_SNAPSHOT
    vi.useRealTimers()
  })

  it("reads the picture's size from the file itself", () => {
    expect(pngSize(Buffer.from(fakePng(1920, 1080), "base64"))).toEqual({
      width: 1920,
      height: 1080,
    })
    expect(pngSize(Buffer.from("not a png at all, just words here"))).toBeNull()
    expect(pngSize(Buffer.alloc(10))).toBeNull()
    expect(pngSize(Buffer.from(fakePng(0, 5), "base64"))).toBeNull()
  })

  it("reports a desktop as stopped without asking when the sandbox is off", async () => {
    const provider = daytonaProvider("k").desktop
    const off = sandbox({ state: "stopped" })
    mock.sandboxes.set("sb-1", off)

    expect(await provider.status("sb-1")).toBe("stopped")
    expect(off.computerUse.getStatus).not.toHaveBeenCalled()
  })

  it("maps the desktop's status words, and treats unknown ones as an error", async () => {
    const provider = daytonaProvider("k").desktop
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})
    const words: Record<string, string> = {
      active: "running",
      running: "running",
      ACTIVE: "running",
      inactive: "stopped",
      stopped: "stopped",
      "": "stopped",
      partial: "starting",
      starting: "starting",
      "something-new": "error",
    }

    for (const [word, expected] of Object.entries(words)) {
      mock.sandboxes.set(
        "sb-1",
        sandbox({
          computerUse: { ...sandbox().computerUse, getStatus: vi.fn(async () => ({ status: word })) },
        })
      )
      expect(await provider.status("sb-1"), word).toBe(expected)
    }
    // The unexpected word was logged so it can be reported.
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("something-new"))
    logged.mockRestore()
  })

  it("starts the desktop and waits for it to come up", async () => {
    const sandboxes = daytonaProvider("k")
    const provider = sandboxes.desktop
    const answers = ["inactive", "partial", "partial", "active"]
    const box = sandbox({
      computerUse: {
        ...sandbox().computerUse,
        getStatus: vi.fn(async () => ({ status: answers.shift() ?? "active" })),
      },
    })
    mock.sandboxes.set("sb-1", box)
    // Load the SDK before the clock is faked: the module load can't run on it.
    await sandboxes.status("sb-1")
    answers.length = 0
    answers.push("inactive", "partial", "partial", "active")

    vi.useFakeTimers()
    const started = provider.start("sb-1")
    await vi.advanceTimersByTimeAsync(10_000)
    await started

    expect(box.computerUse.start).toHaveBeenCalledOnce()
  })

  it("doesn't start a desktop that is already up or on its way", async () => {
    const provider = daytonaProvider("k").desktop

    const up = sandbox()
    mock.sandboxes.set("a", up)
    await provider.start("a")
    expect(up.computerUse.start).not.toHaveBeenCalled()

    const answers = ["starting", "active"]
    const coming = sandbox({
      computerUse: {
        ...sandbox().computerUse,
        getStatus: vi.fn(async () => ({ status: answers.shift() ?? "active" })),
      },
    })
    mock.sandboxes.set("b", coming)
    vi.useFakeTimers()
    const waiting = provider.start("b")
    await vi.advanceTimersByTimeAsync(5_000)
    await waiting
    expect(coming.computerUse.start).not.toHaveBeenCalled()
  })

  it("gives up with a clear message if the desktop never comes up or fails", async () => {
    const provider = daytonaProvider("k").desktop
    const never = sandbox({
      computerUse: {
        ...sandbox().computerUse,
        getStatus: vi.fn(async () => ({ status: "inactive" })),
      },
    })
    mock.sandboxes.set("a", never)
    await provider.status("a")

    vi.useFakeTimers()
    const result = provider.start("a").catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(60_000)
    const error = await result
    expect(error).toBeInstanceOf(SandboxProviderError)
    expect((error as Error).message).toContain("didn't start")
    vi.useRealTimers()

    mock.sandboxes.set(
      "b",
      sandbox({
        computerUse: {
          ...sandbox().computerUse,
          getStatus: vi.fn(async () => {
            throw new DaytonaError("DaytonaInternalServerError", "x https://api/internal key=abc", 500)
          }),
        },
      })
    )
    const failed = await provider.start("b").catch((caught: unknown) => caught)
    expect(failed).toBeInstanceOf(SandboxProviderError)
    expect((failed as Error).message).not.toContain("internal")
  })

  it("takes a PNG screenshot and says how big it is", async () => {
    const provider = daytonaProvider("k").desktop
    const box = sandbox()
    mock.sandboxes.set("sb-1", box)

    const shot = await provider.screenshot("sb-1")

    expect(shot).toEqual({
      base64: fakePng(1280, 720),
      mediaType: "image/png",
      width: 1280,
      height: 720,
    })
    expect(box.computerUse.screenshot.takeCompressed).toHaveBeenCalledWith({
      format: "png",
      showCursor: true,
    })

    // A data: prefix is removed, and something that isn't a PNG is refused.
    box.computerUse.screenshot.takeCompressed.mockResolvedValueOnce({
      screenshot: `data:image/png;base64,${fakePng(800, 600)}`,
    })
    expect(await provider.screenshot("sb-1")).toMatchObject({ width: 800, height: 600 })
    box.computerUse.screenshot.takeCompressed.mockResolvedValueOnce({
      screenshot: Buffer.from("this is a jpeg, honestly").toString("base64"),
    })
    await expect(provider.screenshot("sb-1")).rejects.toThrow(/format the app can read/)
  })

  it("passes clicks, keys, typing and scrolling through as asked", async () => {
    const provider = daytonaProvider("k").desktop
    const box = sandbox()
    mock.sandboxes.set("sb-1", box)

    await provider.click("sb-1", 10, 20)
    await provider.click("sb-1", 1, 2, { button: "right", double: true })
    await provider.move("sb-1", 3, 4)
    await provider.type("sb-1", "hello")
    await provider.press("sb-1", "Return")
    await provider.scroll("sb-1", 5, 6, "down", 3)

    expect(box.computerUse.mouse.click.mock.calls).toEqual([
      [10, 20, "left", false],
      [1, 2, "right", true],
    ])
    expect(box.computerUse.mouse.move).toHaveBeenCalledWith(3, 4)
    expect(box.computerUse.keyboard.type).toHaveBeenCalledWith("hello")
    expect(box.computerUse.keyboard.press).toHaveBeenCalledWith("Return")
    expect(box.computerUse.mouse.scroll).toHaveBeenCalledWith(5, 6, "down", 3)

    box.computerUse.keyboard.press.mockRejectedValueOnce(
      new DaytonaError("DaytonaBadRequestError", "xdotool: unknown key at /usr/bin/x", 400)
    )
    await expect(provider.press("sb-1", "Bogus")).rejects.toThrow(/Try a name like Return/)
  })

  it("builds the viewer address on the signed one, whatever shape that has", async () => {
    const provider = daytonaProvider("k").desktop
    const shapes: [string, (url: URL) => void][] = [
      // The signature is in the host name.
      [
        "https://6080-sb-1.proxy.example.invalid/",
        (url) => {
          expect(url.host).toBe("6080-sb-1.proxy.example.invalid")
          expect(url.pathname).toBe("/vnc.html")
        },
      ],
      // The signature is in the path.
      [
        "https://proxy.example.invalid/s/SIGNED-TOKEN",
        (url) => expect(url.pathname).toBe("/s/SIGNED-TOKEN/vnc.html"),
      ],
      // The signature is in the query.
      [
        "https://proxy.example.invalid/?token=SIGNED-TOKEN",
        (url) => {
          expect(url.pathname).toBe("/vnc.html")
          expect(url.searchParams.get("token")).toBe("SIGNED-TOKEN")
        },
      ],
      // It already points at the viewer page.
      [
        "https://proxy.example.invalid/vnc.html?token=T",
        (url) => {
          expect(url.pathname).toBe("/vnc.html")
          expect(url.searchParams.get("token")).toBe("T")
        },
      ],
    ]

    for (const [signed, check] of shapes) {
      const box = sandbox({
        getSignedPreviewUrl: vi.fn(async () => ({ url: signed, token: "t", port: 6080, sandboxId: "sb-1" })),
      })
      mock.sandboxes.set("sb-1", box)

      const viewing = new URL(await provider.viewerUrl("sb-1", { expiresInSeconds: 300, viewOnly: true }))
      const controlling = new URL(await provider.viewerUrl("sb-1", { expiresInSeconds: 300, viewOnly: false }))

      check(viewing)
      expect(viewing.searchParams.get("view_only")).toBe("true")
      expect(controlling.searchParams.get("view_only")).toBe("false")
      expect(viewing.searchParams.get("autoconnect")).toBe("true")
      expect(viewing.searchParams.get("resize")).toBe("scale")
      // The viewer's port and the requested lifetime were passed on.
      expect(box.getSignedPreviewUrl).toHaveBeenCalledWith(6080, 300)
    }
  })

  it("uses a named snapshot only when one is configured and well formed", async () => {
    mock.createResult = sandbox()
    process.env.DAYTONA_API_KEY = "test-key"

    const plain = getSandboxProvider()!
    await plain.create({ botId: "b", autoStopMinutes: 1, timeoutSeconds: 5 })
    expect(mock.creates[0].params).not.toHaveProperty("snapshot")

    process.env.DAYTONA_SNAPSHOT = "my-desktop-snapshot"
    await getSandboxProvider()!.create({ botId: "b", autoStopMinutes: 1, timeoutSeconds: 5 })
    expect(mock.creates[1].params).toMatchObject({ snapshot: "my-desktop-snapshot" })

    // Anything that isn't a plain name is ignored, not passed on.
    process.env.DAYTONA_SNAPSHOT = "bad name; rm -rf /"
    await getSandboxProvider()!.create({ botId: "b", autoStopMinutes: 1, timeoutSeconds: 5 })
    expect(mock.creates[2].params).not.toHaveProperty("snapshot")
  })
})
