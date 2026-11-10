import { APICallError } from "ai"
import { MockLanguageModelV4, simulateReadableStream } from "ai/test"

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
}

// Tokens one successful fake step reports.
export const FAKE_STEP_USAGE = {
  inputTokens: 10,
  outputTokens: 5,
  totalTokens: 15,
}

// What the fake model does on one call (one step of a reply).
export type FakeStep = {
  // Text chunks to stream, in order.
  text?: string[]
  toolCalls?: { name: string; input: unknown }[]
  // Thrown instead of answering.
  error?: unknown
  // Milliseconds between chunks, to keep a reply "in flight".
  chunkDelayMs?: number
  // Fails after the text chunks have been streamed.
  errorAfterText?: unknown
}

// An HTTP error shaped like the ones the Gemini provider throws.
export function apiError(statusCode: number, message = `HTTP ${statusCode}`) {
  return new APICallError({
    message,
    statusCode,
    url: "https://fake.invalid/model",
    requestBodyValues: {},
    isRetryable: statusCode === 429 || statusCode >= 500,
  })
}

// A model that plays the given steps in order. The last step repeats if the
// model is called more often than there are steps.
export function fakeModel(steps: FakeStep[]) {
  let call = 0
  let toolCallCount = 0

  const model = new MockLanguageModelV4({
    doStream: async () => {
      const step = steps[Math.min(call, steps.length - 1)]
      call++

      if (step.error) {
        throw step.error
      }

      const chunks: unknown[] = [{ type: "stream-start", warnings: [] }]
      if (step.text?.length) {
        const id = `text-${call}`
        chunks.push({ type: "text-start", id })
        for (const delta of step.text) {
          chunks.push({ type: "text-delta", id, delta })
        }
        if (!step.errorAfterText) {
          chunks.push({ type: "text-end", id })
        }
      }
      if (step.errorAfterText) {
        chunks.push({ type: "error", error: step.errorAfterText })
      }
      for (const toolCall of step.toolCalls ?? []) {
        chunks.push({
          type: "tool-call",
          toolCallId: `call-${++toolCallCount}`,
          toolName: toolCall.name,
          input: JSON.stringify(toolCall.input),
        })
      }
      chunks.push({
        type: "finish",
        finishReason: {
          unified: step.toolCalls?.length ? "tool-calls" : "stop",
          raw: "fake",
        },
        usage,
      })

      return {
        stream: simulateReadableStream({
          chunks: chunks as never[],
          initialDelayInMs: step.chunkDelayMs ?? 0,
          chunkDelayInMs: step.chunkDelayMs ?? 0,
        }),
      }
    },
  })

  return Object.assign(model, { callCount: () => call })
}
