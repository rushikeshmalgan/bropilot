import {
  SandboxProviderError,
  type CreateSandboxInput,
  type ExecOptions,
  type SandboxProvider,
  type SandboxState,
} from "@/lib/providers/sandbox"

type FakeBox = {
  id: string
  botId: string
  state: SandboxState
  files: Map<string, Buffer>
  startCount: number
}

type Options = {
  // How long create() takes, to give parallel callers time to collide.
  createDelayMs?: number
  // create() throws this many times before it works.
  failCreates?: number
  // Commands run as an administrator (id -u prints 0).
  rootUser?: boolean
  // delete() fails for these IDs, like the service being down.
  failDeleteFor?: (id: string) => boolean
}

// An in-memory stand-in for Daytona. exec() understands just enough shell for
// tests: echo, cat, pwd, id -u, sleep N, fail, big N and a pipeline that
// writes a file (echo X > path).
export function fakeSandbox(options: Options = {}) {
  const boxes = new Map<string, FakeBox>()
  const log = {
    created: [] as CreateSandboxInput[],
    deleted: [] as string[],
    commands: [] as { id: string; command: string; options: ExecOptions }[],
    started: [] as string[],
  }
  let failCreates = options.failCreates ?? 0
  let counter = 0
  // Settings a test may change while it runs.
  const behaviour = { rootUser: options.rootUser ?? false }

  const need = (id: string) => {
    const box = boxes.get(id)
    if (!box) {
      throw new SandboxProviderError("That sandbox no longer exists.", "not_found")
    }
    return box
  }

  const provider: SandboxProvider = {
    async create(input) {
      if (options.createDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.createDelayMs))
      }
      if (failCreates > 0) {
        failCreates--
        throw new SandboxProviderError("Couldn't create the sandbox.")
      }

      log.created.push(input)
      const id = `box_${++counter}`
      boxes.set(id, {
        id,
        botId: input.botId,
        state: "running",
        files: new Map(),
        startCount: 0,
      })
      return { id }
    },

    async status(id) {
      return boxes.get(id)?.state ?? "missing"
    },

    async start(id) {
      const box = need(id)
      if (box.state === "error") {
        throw new SandboxProviderError("The sandbox is in an error state.")
      }
      if (box.state !== "running") {
        box.state = "running"
        box.startCount++
        log.started.push(id)
      }
    },

    async stop(id) {
      need(id).state = "stopped"
    },

    async exec(id, command, execOptions) {
      const box = need(id)
      if (box.state !== "running") {
        throw new SandboxProviderError("The sandbox isn't running.")
      }
      log.commands.push({ id, command, options: execOptions })

      if (command === "id -u") {
        return {
          exitCode: 0,
          output: behaviour.rootUser ? "0\n" : "1000\n",
          timedOut: false,
        }
      }
      if (command === "pwd") {
        return { exitCode: 0, output: "/home/daytona\n", timedOut: false }
      }
      if (command === "fail") {
        return { exitCode: 3, output: "it failed\n", timedOut: false }
      }

      const sleep = /^sleep (\d+)$/.exec(command)
      if (sleep) {
        // Nothing waits: a sleep longer than the limit simply times out.
        return Number(sleep[1]) > execOptions.timeoutSeconds
          ? { exitCode: 124, output: "", timedOut: true }
          : { exitCode: 0, output: "", timedOut: false }
      }

      const big = /^big (\d+)$/.exec(command)
      if (big) {
        const size = Number(big[1])
        const body = Array.from({ length: size }, (_, i) =>
          String.fromCharCode(97 + (i % 26))
        ).join("")
        return { exitCode: 0, output: body, timedOut: false }
      }

      const cat = /^cat (.+)$/.exec(command)
      if (cat) {
        const file = box.files.get(cat[1])
        return file
          ? { exitCode: 0, output: file.toString("utf8"), timedOut: false }
          : { exitCode: 1, output: `cat: ${cat[1]}: No such file\n`, timedOut: false }
      }

      const write = /^echo (.*) > (\S+)$/.exec(command)
      if (write) {
        box.files.set(write[2], Buffer.from(`${write[1]}\n`))
        return { exitCode: 0, output: "", timedOut: false }
      }

      const echo = /^echo (.*)$/.exec(command)
      if (echo) {
        return { exitCode: 0, output: `${echo[1]}\n`, timedOut: false }
      }

      return { exitCode: 127, output: `${command}: not found\n`, timedOut: false }
    },

    async readFile(id, path, maxBytes) {
      const box = need(id)
      const file = box.files.get(path)
      if (!file) {
        throw new SandboxProviderError("That file doesn't exist.")
      }
      if (file.length > maxBytes) {
        throw new SandboxProviderError(
          `That file is ${file.length} bytes and the limit is ${maxBytes}.`
        )
      }
      return file
    },

    async writeFile(id, path, content) {
      need(id).files.set(path, content)
    },

    async list(id, path) {
      const box = need(id)
      const prefix = path === "." ? "" : `${path.replace(/\/$/, "")}/`
      return [...box.files.entries()]
        .filter(([name]) => name.startsWith(prefix))
        .map(([name, content]) => ({
          name: name.slice(prefix.length),
          path: name,
          isDir: false,
          size: content.length,
        }))
    },

    async delete(id) {
      if (options.failDeleteFor?.(id)) {
        throw new SandboxProviderError("Couldn't delete the sandbox.")
      }
      log.deleted.push(id)
      boxes.delete(id)
    },

    async findByBot(botId) {
      return [...boxes.values()]
        .filter((box) => box.botId === botId)
        .map((box) => box.id)
    },
  }

  return Object.assign(provider, {
    boxes,
    log,
    behaviour,
    // Things a test does to the sandbox behind the app's back.
    switchOff: (id: string) => {
      need(id).state = "stopped"
    },
    breakIt: (id: string) => {
      need(id).state = "error"
    },
    vanish: (id: string) => {
      boxes.delete(id)
    },
    // A sandbox made by a creator that died before recording it.
    plantOrphan: (botId: string) => {
      const id = `orphan_${++counter}`
      boxes.set(id, {
        id,
        botId,
        state: "running",
        files: new Map(),
        startCount: 0,
      })
      return id
    },
    liveFor: (botId: string) =>
      [...boxes.values()].filter((box) => box.botId === botId).length,
  })
}
