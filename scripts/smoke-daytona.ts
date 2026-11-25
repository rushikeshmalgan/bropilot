// Proves the Daytona adapter works against the real service.
//
//   npx tsx scripts/smoke-daytona.ts
//
// Needs DAYTONA_API_KEY. It creates one sandbox, runs a few commands in it,
// writes and reads a file, stops and restarts it, starts the desktop and uses
// its screen, then deletes it. The
// sandbox is deleted even if a step fails. This uses a little of your Daytona
// compute (well under a minute of one small sandbox).
import "./env"

import { nanoid } from "nanoid"

import { hasEnv } from "./env"

// Throws instead of exiting, so the `finally` blocks that remove what the
// check created still run. The handler at the bottom prints it and exits 1.
function fail(message: string): never {
  throw new Error(message)
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) {
    fail(message)
  }
}

async function main() {
  if (!hasEnv("DAYTONA_API_KEY")) {
    console.log("SKIP: DAYTONA_API_KEY is not set.")
    return
  }

  const { getSandboxProvider } = await import("@/lib/providers")
  const provider = getSandboxProvider()
  if (!provider) {
    fail("DAYTONA_API_KEY is set but isn't a usable key (masked value?).")
  }

  const botId = `smoke_${nanoid(8)}`
  let sandboxId: string | null = null

  try {
    const created = await provider.create({
      botId,
      autoStopMinutes: 5,
      timeoutSeconds: 90,
    })
    sandboxId = created.id
    console.log(`ok   created a sandbox (user: ${created.user ?? "not reported"})`)
    check((await provider.status(sandboxId)) === "running", "a new sandbox isn't running")

    const who = await provider.exec(sandboxId, "id -u", { timeoutSeconds: 15 })
    check(who.exitCode === 0, `id -u failed: ${who.output.slice(0, 100)}`)
    check(
      who.output.trim() !== "0",
      "commands run as root (user id 0): the app would refuse this sandbox"
    )
    console.log(`ok   commands run as user id ${who.output.trim()}, not root`)

    const echoed = await provider.exec(sandboxId, "echo smoke-test", {
      timeoutSeconds: 15,
    })
    check(
      echoed.exitCode === 0 && echoed.output.trim() === "smoke-test",
      `echo returned ${JSON.stringify(echoed)}`
    )
    console.log("ok   ran a command and read its output")

    const failing = await provider.exec(sandboxId, "exit 7", { timeoutSeconds: 15 })
    check(failing.exitCode === 7, `exit code was ${failing.exitCode}, not 7`)
    console.log("ok   a failing command reports its exit code")

    const slow = await provider.exec(sandboxId, "sleep 30", { timeoutSeconds: 3 })
    check(
      slow.timedOut || slow.exitCode !== 0,
      "a command over its time limit was not stopped"
    )
    console.log(
      `ok   a command over its limit was stopped (reported as ${slow.timedOut ? "timed out" : `exit ${slow.exitCode}`})`
    )

    // Nothing from this machine's environment may be visible in the sandbox.
    process.env.SMOKE_SECRET_CANARY = "canary-value-should-not-travel"
    const env = await provider.exec(sandboxId, "env", { timeoutSeconds: 15 })
    check(
      !env.output.includes("canary-value-should-not-travel") &&
        !env.output.includes("DAYTONA_API_KEY"),
      "this machine's environment is visible inside the sandbox"
    )
    console.log("ok   none of this machine's environment is visible inside it")

    await provider.writeFile(sandboxId, "smoke/note.txt", Buffer.from("remember me"))
    const read = await provider.readFile(sandboxId, "smoke/note.txt", 1000)
    check(read.toString() === "remember me", "the file came back different")
    const listed = await provider.list(sandboxId, "smoke")
    check(
      listed.some((entry) => entry.name === "note.txt" && !entry.isDir),
      "the file isn't in its folder's listing"
    )
    await provider
      .readFile(sandboxId, "smoke/note.txt", 3)
      .then(() => fail("a file over the size limit was read"))
      .catch((error: unknown) => {
        check(
          error instanceof Error && /limit/.test(error.message),
          "the size limit error wasn't clear"
        )
      })
    console.log("ok   wrote, read and listed a file; the size limit holds")

    const found = await provider.findByBot(botId)
    check(found.includes(sandboxId), "the sandbox can't be found by its bot's label")
    console.log("ok   the sandbox is found by its bot's label")

    await provider.stop(sandboxId)
    check((await provider.status(sandboxId)) === "stopped", "stop didn't stop it")
    await provider.start(sandboxId)
    check((await provider.status(sandboxId)) === "running", "start didn't start it")
    const kept = await provider.readFile(sandboxId, "smoke/note.txt", 1000)
    check(kept.toString() === "remember me", "the file was lost over a stop and start")
    console.log("ok   stopped and restarted it; the file survived")

    // --- The desktop (docs/computer-use.md, "What I'm unsure about") ---
    const desktop = provider.desktop
    await desktop.start(sandboxId).catch((error: unknown) => {
      fail(
        `the desktop didn't start: ${error instanceof Error ? error.message : error}. If the default sandbox image has no desktop, set DAYTONA_SNAPSHOT to a snapshot that does.`
      )
    })
    check((await desktop.status(sandboxId)) === "running", "the desktop isn't running after start")
    console.log("ok   started the desktop; its status words are understood")

    const shot = await desktop.screenshot(sandboxId)
    check(
      shot.width > 100 && shot.height > 100 && shot.base64.length > 1000,
      "the screenshot is empty or too small"
    )
    console.log(`ok   took a PNG screenshot, ${shot.width} by ${shot.height} pixels`)

    await desktop.move(sandboxId, Math.floor(shot.width / 2), Math.floor(shot.height / 2))
    await desktop.click(sandboxId, Math.floor(shot.width / 2), Math.floor(shot.height / 2))
    await desktop.scroll(sandboxId, 10, 10, "down", 1)
    await desktop.type(sandboxId, "x")
    await desktop.press(sandboxId, "Escape").catch((error: unknown) => {
      fail(
        `the key "Escape" wasn't accepted (${error instanceof Error ? error.message : error}): the key names need checking`
      )
    })
    console.log("ok   move, click, scroll, type and a key press were accepted")

    const viewing = await desktop.viewerUrl(sandboxId, {
      expiresInSeconds: 120,
      viewOnly: true,
    })
    const viewer = new URL(viewing)
    check(viewer.pathname.endsWith("vnc.html"), "the viewer address doesn't end in vnc.html")
    check(viewer.searchParams.get("view_only") === "true", "the address isn't view-only")
    // Only facts about the address are printed, never the address itself: it
    // carries the token that lets anyone watch the screen.
    console.log(
      `ok   made a viewer address (host contains the sandbox id: ${viewer.host.includes(sandboxId) ? "YES" : "no"})`
    )

    const page = await fetch(viewing, { redirect: "follow" }).catch(() => null)
    check(page, "the viewer address couldn't be fetched")
    check(page.ok, `the viewer page answered ${page.status}`)
    const frameOptions = page.headers.get("x-frame-options")
    const csp = page.headers.get("content-security-policy") ?? ""
    const frameAncestors = /frame-ancestors[^;]*/i.exec(csp)?.[0] ?? null
    console.log(
      `ok   the viewer page loads (x-frame-options: ${frameOptions ?? "none"}; ${frameAncestors ?? "no frame-ancestors rule"})`
    )
    if (frameOptions || frameAncestors) {
      console.log(
        "WARN the provider's page may refuse to be shown inside another page: check the viewer in the browser before relying on it"
      )
    }
  } finally {
    if (sandboxId) {
      await provider.delete(sandboxId).catch((error: unknown) => {
        console.error(
          `Couldn't delete sandbox ${sandboxId}: ${error instanceof Error ? error.message : error}. Remove it from the Daytona dashboard.`
        )
      })
    }
  }

  check(
    (await provider.status(sandboxId!)) === "missing",
    "the sandbox still exists after delete"
  )
  check(
    !(await provider.findByBot(botId)).includes(sandboxId!),
    "the deleted sandbox is still listed"
  )
  await provider.delete(sandboxId!)
  console.log("ok   deleted it; deleting again is fine")
  console.log("PASS")
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
)
