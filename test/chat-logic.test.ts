import { describe, expect, it } from "vitest"

import { RATE_LIMIT_MAX_MESSAGES, RATE_LIMIT_WINDOW_MS } from "@/lib/ai"
import { BOT_FACES, botFaceUrl, faceFor, randomBotFace } from "@/lib/bot-faces"
import { pickBot, toModelMessages } from "@/lib/agent/run-model"
import { checkRateLimit } from "@/lib/rate-limit"

const ada = { id: "a", name: "Ada", job: "x" }
const ann = { id: "b", name: "Ann", job: "x" }
const annMarie = { id: "c", name: "Ann Marie", job: "x" }

describe("pickBot", () => {
  it("uses the only bot in a one-on-one chat, whatever is mentioned", () => {
    expect(pickBot([ada], "@Ann hello", [])).toBe(ada)
  })

  it("picks the mentioned bot, ignoring case", () => {
    expect(pickBot([ada, ann], "@ann hello", [])).toBe(ann)
  })

  it("prefers the longest matching name", () => {
    expect(pickBot([ann, annMarie], "@Ann Marie hi", [])).toBe(annMarie)
  })

  it("does not match a mention inside a longer word", () => {
    expect(pickBot([ada, ann], "@Annabel hi", [])).toBe(ada)
  })

  it("falls back to the last speaker, then the first bot", () => {
    const history = [{ role: "assistant" as const, botId: "b" }]
    expect(pickBot([ada, ann], "hi", history)).toBe(ann)
    expect(pickBot([ada, ann], "hi", [])).toBe(ada)
  })

  it("treats regex characters in a name as plain text", () => {
    const odd = { id: "d", name: "C++ (dev)", job: "x" }
    expect(pickBot([ada, odd], "@C++ (dev) hi", [])).toBe(odd)
    expect(pickBot([ada, odd], "@Cxx hi", [])).toBe(ada)
  })
})

describe("toModelMessages", () => {
  const text = (value: string) => [{ type: "text" as const, text: value }]

  it("drops failed and empty messages and merges neighbours", () => {
    const messages = toModelMessages(
      [
        { role: "user", botId: null, status: "done", parts: text("one") },
        { role: "assistant", botId: "a", status: "error", parts: text("busy") },
        { role: "user", botId: null, status: "done", parts: text("two") },
        { role: "assistant", botId: "a", status: "done", parts: text("  ") },
      ],
      "a",
      new Map(),
      false
    )
    expect(messages).toEqual([{ role: "user", content: "one\n\ntwo" }])
  })

  it("shows other bots' replies as named context in a group", () => {
    const messages = toModelMessages(
      [
        { role: "user", botId: null, status: "done", parts: text("hi") },
        { role: "assistant", botId: "b", status: "done", parts: text("yo") },
        { role: "assistant", botId: "a", status: "done", parts: text("hey") },
      ],
      "a",
      new Map([["b", "Ann"]]),
      true
    )
    expect(messages).toEqual([
      {
        role: "user",
        content: "hi\n\n[Ann is another bot, not the user. It wrote:]\nyo",
      },
      { role: "assistant", content: "hey" },
    ])
  })

  it("always starts with the user", () => {
    const messages = toModelMessages(
      [{ role: "assistant", botId: "a", status: "done", parts: text("hey") }],
      "a",
      new Map(),
      false
    )
    expect(messages).toEqual([])
  })
})

describe("checkRateLimit", () => {
  it("allows the limit, refuses the next, and recovers after the window", () => {
    const user = `rate_${Math.random()}`
    const start = 1_000_000
    for (let i = 0; i < RATE_LIMIT_MAX_MESSAGES; i++) {
      expect(checkRateLimit(user, start + i).ok).toBe(true)
    }
    expect(checkRateLimit(user, start + 100).ok).toBe(false)
    expect(checkRateLimit(user, start + RATE_LIMIT_WINDOW_MS + 100).ok).toBe(
      true
    )
  })

  it("counts each user separately", () => {
    const a = `rate_${Math.random()}`
    const b = `rate_${Math.random()}`
    for (let i = 0; i < RATE_LIMIT_MAX_MESSAGES; i++) {
      checkRateLimit(a, 5)
    }
    expect(checkRateLimit(a, 6).ok).toBe(false)
    expect(checkRateLimit(b, 6).ok).toBe(true)
  })
})

describe("bot faces", () => {
  it("maps any seed to one of the 50 faces, stably", () => {
    expect(BOT_FACES).toHaveLength(50)
    expect(faceFor("ada")).toBe("ada")
    expect(faceFor("a3f9c2d1")).toBe(faceFor("a3f9c2d1"))
    expect(BOT_FACES).toContain(faceFor("some old random seed"))
    expect(botFaceUrl("ada")).toBe("/bots/ada.svg")
  })

  it("never returns the excluded face", () => {
    for (let i = 0; i < 200; i++) {
      expect(randomBotFace("ada")).not.toBe("ada")
    }
  })
})
