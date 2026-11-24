import { describe, expect, it } from "vitest"

import {
  DEFAULT_TRACES_SAMPLE_RATE,
  sentryOptions,
  tracesSampleRate,
} from "@/lib/sentry-options"
import {
  REDACTED,
  cleanTags,
  scrubBreadcrumb,
  scrubEvent,
  scrubSpan,
  scrubString,
  scrubValue,
} from "@/lib/sentry-scrub"

// Every secret here is made up and built in pieces, so nothing in this file is
// a real key or looks like one to a secret scanner.
const SECRETS: Record<string, string> = {
  "an OpenAI-style key": ["sk", "-", "Ab12Cd34Ef56Gh78Ij90"].join(""),
  "a Google API key": ["AI", "za", "SyA1b2C3d4E5f6G7h8I9j0K1l2M3"].join(""),
  "a Trigger.dev dev key": ["tr", "_dev_", "Ab12Cd34Ef56Gh78"].join(""),
  "a Trigger.dev prod key": ["tr", "_prod_", "Ab12Cd34Ef56Gh78"].join(""),
  "a Trigger.dev access token": ["tr", "_pat_", "Ab12Cd34Ef56Gh78"].join(""),
  "a Clerk secret key": ["sk", "_test_", "Ab12Cd34Ef56Gh78Ij90"].join(""),
  "a Clerk publishable key": ["pk", "_live_", "Ab12Cd34Ef56Gh78Ij90"].join(""),
  "a bearer header": ["Bear", "er abcDEF123456.token-value_xyz"].join(""),
  "a JSON web token": [
    "eyJhbGciOiJIUzI1NiJ9",
    "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
    "dBjftJeZ4CVPmB92K27uhbUJU1p1rwW1gFWFOEjXk",
  ].join("."),
  "a database URL with a password": [
    "postgresql://",
    "app_user:p4ssw0rdXYZ@",
    "ep-cool-123.neon.tech/db?sslmode=require",
  ].join(""),
  "a Firecrawl key": ["fc", "-", "0123456789abcdef0123456789abcdef"].join(""),
  "a Daytona key": ["dtn", "_", "Ab12Cd34Ef56Gh78Ij90"].join(""),
  "a Sentry auth token": ["sntrys", "_", "eyJpYXQiOjE2ODAwMDAwMDB9abcdef"].join(""),
  "a GitHub token": ["gh", "p_", "abcdefghijklmnopqrstuvwxyz0123456789"].join(""),
  "an AWS key ID": ["AK", "IA", "IOSFODNN7EXAMPLE"].join(""),
  "a password in a setting": "password=hunter2hunter2",
  "a quoted api key": '"api_key": "abcd1234efgh"',
  "a long mixed token": "q7Hn2vB9xZk4Lw8Rt1Yc6Pd3Fs5Jm0Ga9Ue2Ni4O",
}

describe("scrubString", () => {
  for (const [name, secret] of Object.entries(SECRETS)) {
    it(`removes ${name}`, () => {
      const clean = scrubString(`before ${secret} after`)
      expect(clean).not.toContain(secret)
      // The secret's distinctive part is gone, not just the prefix.
      expect(clean).not.toMatch(/hunter2hunter2|abcd1234efgh|p4ssw0rdXYZ/)
      expect(clean).toContain("before")
      expect(clean).toContain("after")
      expect(clean).toContain(REDACTED)
    })
  }

  it("removes a secret in the middle of other text, however it is quoted", () => {
    const key = SECRETS["an OpenAI-style key"]
    for (const text of [
      `{"apiKey":"${key}"}`,
      `Authorization: ${key}`,
      `https://example.com/?key=${key}&x=1`,
      `(${key})`,
      `\n${key}\n`,
    ]) {
      expect(scrubString(text)).not.toContain(key.slice(5))
    }
  })

  it("leaves ordinary text, IDs, UUIDs and long plain words alone", () => {
    for (const text of [
      "The run failed in step 3 for bot Testbot.",
      "5f0e1c2a-8b9d-4e3f-a1b2-c3d4e5f60718",
      "V1StGXR8_Z5jdHi6B-myT",
      "a".repeat(40),
      "internationalizationLocalizationConfigurationManagerFactory",
    ]) {
      expect(scrubString(text)).toBe(text)
    }
  })

  it("cuts long text", () => {
    const clean = scrubString("word ".repeat(500))
    expect(clean.length).toBeLessThan(400)
    expect(clean).toContain("(cut)")
  })

  it("stays fast on huge input", () => {
    const started = Date.now()
    scrubString("a-1-".repeat(2_000_000))
    scrubString("x".repeat(5_000_000))
    scrubString("Bearer ".repeat(500_000))
    expect(Date.now() - started).toBeLessThan(3000)
  })
})

describe("scrubValue", () => {
  it("replaces whatever sits under the names that hold people's words and tool results", () => {
    const clean = scrubValue({
      text: "MY PRIVATE MESSAGE",
      content: [{ type: "text", text: "MY PRIVATE MESSAGE" }],
      parts: [{ type: "text", text: "MY PRIVATE MESSAGE" }],
      memory: "MEMORY CONTENT",
      memoryContent: "MEMORY CONTENT",
      input: { query: "MY PRIVATE MESSAGE" },
      output: "TOOL OUTPUT",
      toolOutput: "TOOL OUTPUT",
      result: "TOOL OUTPUT",
      stdout: "COMMAND OUTPUT",
      stderr: "COMMAND OUTPUT",
      command: "cat ~/.ssh/id_rsa",
      image: "data:image/png;base64,AAAA",
      screenshot: "AAAA",
      instructions: "BOT INSTRUCTIONS",
      "gen_ai.input.messages": "MY PRIVATE MESSAGE",
      "gen_ai.response.text": "MY PRIVATE MESSAGE",
      "gen_ai.tool.call.arguments": "MY PRIVATE MESSAGE",
      "db.query.text": "select * from messages",
      headers: { cookie: "SESSION" },
      authorization: "Bearer abc",
      kept: "a harmless note",
      count: 3,
    })

    const text = JSON.stringify(clean)
    for (const marker of [
      "MY PRIVATE MESSAGE",
      "MEMORY CONTENT",
      "TOOL OUTPUT",
      "COMMAND OUTPUT",
      "id_rsa",
      "AAAA",
      "BOT INSTRUCTIONS",
      "select *",
      "SESSION",
    ]) {
      expect(text).not.toContain(marker)
    }
    expect(clean).toMatchObject({ kept: "a harmless note", count: 3 })
  })

  it("cuts deep and long structures and drops things that aren't data", () => {
    let deep: Record<string, unknown> = { value: "bottom" }
    for (let i = 0; i < 30; i++) {
      deep = { next: deep }
    }
    expect(JSON.stringify(scrubValue(deep))).not.toContain("bottom")

    const long = scrubValue({ list: Array.from({ length: 500 }, (_, i) => i) })
    expect((long as { list: unknown[] }).list).toHaveLength(50)

    const odd = scrubValue({ fn: () => "secret", sym: Symbol("x") })
    expect(odd).toEqual({ fn: REDACTED, sym: REDACTED })
  })

  it("does not change what it is given", () => {
    const original = { text: "hello", nested: { note: `key ${SECRETS["a Google API key"]}` } }
    const copy = structuredClone(original)
    scrubValue(original)
    expect(original).toEqual(copy)
  })
})

function sampleEvent() {
  return {
    event_id: "0123456789abcdef0123456789abcdef",
    timestamp: 1_700_000_000,
    level: "error",
    platform: "node",
    environment: "production",
    server_name: "my-laptop",
    message: "log text with MY PRIVATE MESSAGE",
    request: {
      url: "https://app.example/api/chat?token=QUERYSECRET1&q=MY+PRIVATE+MESSAGE",
      method: "POST",
      query_string: "token=QUERYSECRET1",
      headers: {
        cookie: "sess=COOKIEVALUE",
        authorization: "Bearer HEADERSECRET1234",
      },
      cookies: { sess: "COOKIEVALUE" },
      data: { text: "MY PRIVATE MESSAGE" },
    },
    user: {
      id: "user_2abcDEF",
      email: "person@example.com",
      ip_address: "203.0.113.9",
      username: "person",
    },
    extra: { messageText: "MY PRIVATE MESSAGE", memory: "MEMORY CONTENT" },
    contexts: {
      trace: {
        trace_id: "11111111111111111111111111111111",
        span_id: "2222222222222222",
        data: { "gen_ai.input.messages": "MY PRIVATE MESSAGE" },
      },
      runtime: { name: "node", version: "22.1.0", extra: "MY PRIVATE MESSAGE" },
      culture: { timezone: "Asia/Kolkata", locale: "en-IN" },
      device: { name: "my-laptop", model: "PRIVATEMODEL" },
      state: { state: { value: { text: "STATE TEXT" } } },
    },
    breadcrumbs: [
      {
        type: "http",
        category: "fetch",
        message: "fetch https://x.example/?y=SECRETCRUMB",
        data: { url: "https://x.example/?y=SECRETCRUMB", body: "CRUMBBODY" },
        timestamp: 1_700_000_000,
      },
      { category: "console", message: "MY PRIVATE MESSAGE", level: "log" },
    ],
    tags: {
      userId: "user_2abcDEF",
      botId: "bot_abc123",
      chatId: "chat_abc123",
      runId: "run_abc123",
      runtime: "node",
      stray: "MY PRIVATE MESSAGE",
    },
    exception: {
      values: [
        {
          type: "TypeError",
          value: "Cannot read properties of undefined",
          mechanism: { type: "generic", handled: false, data: { text: "MECHDATA" } },
          stacktrace: {
            frames: [
              {
                filename: "app/lib/thing.ts",
                function: "doThing",
                lineno: 10,
                colno: 5,
                in_app: true,
                vars: { text: "FRAME VAR" },
                pre_context: ["const secret = 'PRECONTEXT'"],
                context_line: "CONTEXTLINE",
                post_context: ["POSTCONTEXT"],
              },
            ],
          },
        },
      ],
    },
    modules: { next: "16.4.5" },
  }
}

describe("scrubEvent", () => {
  it("sends the error, where it happened and the four IDs, and nothing a person wrote", () => {
    const clean = scrubEvent(sampleEvent())
    expect(clean).not.toBeNull()
    const text = JSON.stringify(clean)

    for (const marker of [
      "MY PRIVATE MESSAGE",
      "MY+PRIVATE",
      "COOKIEVALUE",
      "HEADERSECRET1234",
      "QUERYSECRET1",
      "person@example.com",
      "203.0.113.9",
      "username",
      "MEMORY CONTENT",
      "SECRETCRUMB",
      "CRUMBBODY",
      "FRAME VAR",
      "PRECONTEXT",
      "CONTEXTLINE",
      "POSTCONTEXT",
      "STATE TEXT",
      "MECHDATA",
      "Asia/Kolkata",
      "PRIVATEMODEL",
      "my-laptop",
    ]) {
      expect(text, marker).not.toContain(marker)
    }

    expect(clean).toMatchObject({
      level: "error",
      environment: "production",
      request: { method: "POST", url: "https://app.example/api/chat" },
      user: { id: "user_2abcDEF" },
      tags: {
        userId: "user_2abcDEF",
        botId: "bot_abc123",
        chatId: "chat_abc123",
        runId: "run_abc123",
        runtime: "node",
      },
      contexts: {
        trace: { trace_id: "11111111111111111111111111111111" },
        runtime: { name: "node", version: "22.1.0" },
      },
      exception: {
        values: [
          {
            type: "TypeError",
            value: "Cannot read properties of undefined",
            stacktrace: {
              frames: [
                { filename: "app/lib/thing.ts", function: "doThing", lineno: 10 },
              ],
            },
          },
        ],
      },
    })
    expect((clean as { tags: Record<string, string> }).tags).not.toHaveProperty("stray")
    expect((clean as { user: object }).user).toEqual({ id: "user_2abcDEF" })
  })

  it("keeps only the user's ID, and only if it looks like one", () => {
    const clean = scrubEvent({ user: { id: "has spaces and an email@x.com" } })
    expect(clean).not.toHaveProperty("user")
  })

  it("drops tags other than the four IDs, and IDs that don't look like IDs", () => {
    const clean = scrubEvent({
      tags: {
        userId: "user 1; drop table",
        botId: "b".repeat(100),
        chatId: "chat_ok",
        runId: 42,
        anything: "else",
      },
    }) as { tags: Record<string, unknown> }
    expect(clean.tags).toEqual({ chatId: "chat_ok" })
  })

  it("removes keys from an error's message, and replaces a message that carries content", () => {
    const key = SECRETS["an OpenAI-style key"]
    const withKey = scrubEvent({
      exception: { values: [{ type: "Error", value: `Request failed for key ${key}` }] },
    })
    const keyText = JSON.stringify(withKey)
    expect(keyText).not.toContain(key)
    expect(keyText).toContain("Request failed")

    const withContent = scrubEvent({
      exception: {
        values: [
          {
            type: "AI_InvalidPromptError",
            value: 'Invalid prompt: {"role":"user","content":"my secret plans"}',
          },
        ],
      },
    })
    const contentText = JSON.stringify(withContent)
    expect(contentText).not.toContain("secret plans")
    expect(contentText).toContain("AI_InvalidPromptError")
  })

  it("removes keys and message text wherever they are in what is left", () => {
    const key = SECRETS["a Google API key"]
    const clean = scrubEvent({
      transaction: `GET /api/runs/abc?key=${key}`,
      spans: [
        {
          description: `POST https://api.example/v1?key=${key}`,
          op: "http.client",
          data: { "gen_ai.input.messages": "MY PRIVATE MESSAGE", note: `k ${key}` },
        },
      ],
      sdk: { name: "sentry.javascript.nextjs", version: "11.17.0" },
    })
    const text = JSON.stringify(clean)
    expect(text).not.toContain(key)
    expect(text).not.toContain("MY PRIVATE MESSAGE")
    expect(text).toContain("/api/runs/abc")
    expect(text).toContain("sentry.javascript.nextjs")
  })

  it("keeps the last 60 stack frames and 30 breadcrumbs, no more", () => {
    const frames = Array.from({ length: 200 }, (_, i) => ({ filename: `f${i}.ts` }))
    const crumbs = Array.from({ length: 100 }, (_, i) => ({ category: `c${i}` }))
    const clean = scrubEvent({
      exception: { values: [{ type: "Error", value: "x", stacktrace: { frames } }] },
      breadcrumbs: crumbs,
    }) as {
      exception: { values: { stacktrace: { frames: { filename: string }[] } }[] }
      breadcrumbs: { category: string }[]
    }
    expect(clean.exception.values[0].stacktrace.frames).toHaveLength(60)
    expect(clean.exception.values[0].stacktrace.frames.at(-1)?.filename).toBe("f199.ts")
    expect(clean.breadcrumbs).toHaveLength(30)
    expect(clean.breadcrumbs.at(-1)?.category).toBe("c99")
  })

  it("is the same when run twice, and leaves the original alone", () => {
    const original = sampleEvent()
    const copy = structuredClone(original)
    const once = scrubEvent(original)
    expect(original).toEqual(copy)
    expect(scrubEvent(once as object)).toEqual(once)
  })

  it("drops the event when cleaning fails, rather than sending it", () => {
    const hostile = {
      get exception(): never {
        throw new Error("boom")
      },
      message: "MY PRIVATE MESSAGE",
    }
    expect(scrubEvent(hostile)).toBeNull()
  })

  it("copes with events that have unexpected shapes", () => {
    for (const odd of [
      {},
      { exception: "text" },
      { exception: { values: "text" } },
      { exception: { values: [null, 5, "x", { stacktrace: "x" }] } },
      { breadcrumbs: "x" },
      { breadcrumbs: [null, 3, "x"] },
      { tags: "x" },
      { contexts: [] },
      { request: 5 },
      { spans: "x" },
      { spans: [null, 1] },
    ]) {
      expect(() => scrubEvent(odd)).not.toThrow()
      expect(scrubEvent(odd)).not.toBeNull()
    }
  })
})

describe("scrubSpan", () => {
  it("keeps timing and IDs, drops message text and tool output, and strips query strings", () => {
    const clean = scrubSpan({
      span_id: "2222222222222222",
      trace_id: "11111111111111111111111111111111",
      op: "http.client",
      status: "ok",
      start_timestamp: 1,
      timestamp: 2,
      description: "GET https://api.example.com/v1/x?key=SECRETQUERY#frag",
      data: {
        "gen_ai.input.messages": "MY PRIVATE MESSAGE",
        "gen_ai.response.text": "MY PRIVATE MESSAGE",
        "gen_ai.tool.call.result": "TOOL OUTPUT",
        "db.query.text": "select * from messages where text = 'MY PRIVATE MESSAGE'",
        "gen_ai.usage.input_tokens": 12,
        "tool.name": "webSearch",
        "http.url": "https://a.example/p?q=PRIVATE",
        "http.response.status_code": 200,
      },
    })
    const text = JSON.stringify(clean)

    for (const marker of ["MY PRIVATE MESSAGE", "TOOL OUTPUT", "SECRETQUERY", "frag", "PRIVATE", "select *"]) {
      expect(text, marker).not.toContain(marker)
    }
    expect(clean).toMatchObject({
      span_id: "2222222222222222",
      op: "http.client",
      status: "ok",
      description: "GET https://api.example.com/v1/x",
      data: {
        "gen_ai.usage.input_tokens": 12,
        "tool.name": "webSearch",
        "http.url": "https://a.example/p",
        "http.response.status_code": 200,
      },
    })
  })

  it("cleans a streamed span, where attributes are a map and values may be wrapped", () => {
    const key = SECRETS["an OpenAI-style key"]
    const clean = scrubSpan({
      trace_id: "11111111111111111111111111111111",
      span_id: "2222222222222222",
      parent_span_id: "3333333333333333",
      name: "GET https://api.example.com/v1/x?key=SECRETQUERY",
      status: "ok",
      is_segment: false,
      start_timestamp: 1,
      end_timestamp: 2,
      attributes: {
        "sentry.op": "http.client",
        "tool.name": "webSearch",
        "url.full": "https://api.example.com/v1/x?key=SECRETQUERY",
        "http.target": "/api/runs/abc?token=SECRETQUERY",
        "gen_ai.input.messages": { value: "MY PRIVATE MESSAGE", type: "string" },
        "gen_ai.response.text": "MY PRIVATE MESSAGE",
        "gen_ai.tool.call.result": ["TOOL OUTPUT"],
        "db.query.text": "select 'MY PRIVATE MESSAGE'",
        "http.response.status_code": { value: 200, type: "integer" },
        note: `used ${key}`,
      },
      links: [{ trace_id: "x", span_id: "y", attributes: { text: "MY PRIVATE MESSAGE" } }],
    })
    const text = JSON.stringify(clean)

    for (const marker of ["MY PRIVATE MESSAGE", "TOOL OUTPUT", "SECRETQUERY", "select '", key.slice(5)]) {
      expect(text, marker).not.toContain(marker)
    }
    expect(clean).toMatchObject({
      span_id: "2222222222222222",
      parent_span_id: "3333333333333333",
      name: "GET https://api.example.com/v1/x",
      status: "ok",
      is_segment: false,
      attributes: {
        "sentry.op": "http.client",
        "tool.name": "webSearch",
        "url.full": "https://api.example.com/v1/x",
        "http.target": "/api/runs/abc",
        "http.response.status_code": { value: 200, type: "integer" },
      },
    })
    expect(clean).not.toHaveProperty("links")
  })

  it("drops attributes about the person or their machine", () => {
    const clean = scrubSpan({
      attributes: {
        "user.id": "user_1",
        "user.ip_address": "203.0.113.9",
        "client.address": "203.0.113.9",
        "http.client_ip": "203.0.113.9",
        "culture.timezone": "Asia/Kolkata",
        "device.cpu_description": "Some CPU",
        "os.name": "Windows",
        "run.id": "run_1",
      },
    })
    expect(clean).toEqual({ attributes: { "os.name": "Windows", "run.id": "run_1" } })
  })

  it("removes keys from a span's name and attributes", () => {
    const key = SECRETS["an OpenAI-style key"]
    const clean = scrubSpan({
      description: `tool run ${key}`,
      data: { detail: `used ${key}` },
    })
    expect(JSON.stringify(clean)).not.toContain(key)
  })
})

describe("scrubBreadcrumb", () => {
  it("keeps that something happened, not what", () => {
    const clean = scrubBreadcrumb({
      type: "default",
      category: "console",
      level: "warning",
      timestamp: 5,
      message: "MY PRIVATE MESSAGE",
      data: { arguments: ["MY PRIVATE MESSAGE"] },
    })
    expect(clean).toEqual({
      type: "default",
      category: "console",
      level: "warning",
      timestamp: 5,
    })
  })
})

describe("cleanTags", () => {
  it("keeps the four IDs when they look like IDs", () => {
    expect(
      cleanTags({ userId: "user_2abc", botId: "a b", chatId: "c-1", runId: "" })
    ).toEqual({ userId: "user_2abc", chatId: "c-1" })
  })
})

describe("sentryOptions", () => {
  it("turns off everything the SDK would collect by itself, and routes events through the scrubbers", () => {
    const options = sentryOptions("https://key@o0.ingest.example/1")
    expect(options.dsn).toBe("https://key@o0.ingest.example/1")
    expect(options.dataCollection).toMatchObject({
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      stackFrameVariables: false,
    })
    // The SDK's own AI, console and screen-recording integrations are removed.
    const names = ["Http", "VercelAI", "OpenAI", "Console", "LocalVariablesAsync", "Replay", "Dedupe"]
    expect(
      options.integrations(names.map((name) => ({ name }))).map((i) => i.name)
    ).toEqual(["Http", "Dedupe"])
    expect(options.beforeSend).toBe(scrubEvent)
    expect(options.beforeSendSpan).toBe(scrubSpan)
    // Ignored (with a warning) while spans are streamed, so it is not set.
    expect(options).not.toHaveProperty("beforeSendTransaction")
    expect(options.beforeBreadcrumb).toBe(scrubBreadcrumb)
  })

  it("reads the trace sample rate, and falls back when it makes no sense", () => {
    expect(tracesSampleRate(undefined)).toBe(DEFAULT_TRACES_SAMPLE_RATE)
    expect(tracesSampleRate("")).toBe(DEFAULT_TRACES_SAMPLE_RATE)
    expect(tracesSampleRate("  ")).toBe(DEFAULT_TRACES_SAMPLE_RATE)
    expect(tracesSampleRate("abc")).toBe(DEFAULT_TRACES_SAMPLE_RATE)
    expect(tracesSampleRate("2")).toBe(DEFAULT_TRACES_SAMPLE_RATE)
    expect(tracesSampleRate("-0.5")).toBe(DEFAULT_TRACES_SAMPLE_RATE)
    expect(tracesSampleRate("0")).toBe(0)
    expect(tracesSampleRate("0.25")).toBe(0.25)
    expect(tracesSampleRate("1")).toBe(1)
  })
})
