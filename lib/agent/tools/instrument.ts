// Puts a span around every tool call, so a slow or failing tool shows up in
// the trace of the reply it belonged to. A span carries the tool's name and
// nothing else: not what the model asked for, not what came back.
import type { ToolSet } from "ai"

import { isToolFailure } from "@/lib/agent/tools/shared"
import { telemetryEnabled, withSpan } from "@/lib/observability"

type Execute = (input: unknown, options: unknown) => unknown

export function instrumentTools(tools: ToolSet): ToolSet {
  // Without Sentry the tools are used exactly as they are.
  if (!telemetryEnabled()) {
    return tools
  }

  const wrapped: ToolSet = {}
  for (const [name, definition] of Object.entries(tools)) {
    const execute = definition.execute as Execute | undefined
    if (typeof execute !== "function") {
      wrapped[name] = definition
      continue
    }

    wrapped[name] = {
      ...definition,
      execute: (input: unknown, options: unknown) =>
        withSpan(
          {
            name: `tool ${name}`,
            op: "tool",
            attributes: { "tool.name": name },
          },
          async (span) => {
            // The tool is called as it always was; this only watches. A result
            // that is a stream is handed back as it is, and its span ends here.
            const output = await execute.call(definition, input, options)
            if (isToolFailure(output)) {
              span.fail("tool returned an error")
            }
            return output
          }
        ),
    } as typeof definition
  }
  return wrapped
}
