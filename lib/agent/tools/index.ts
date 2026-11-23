// The tools a bot has for one run. A tool is only offered when the service
// behind it is configured, so the model never sees a tool that can't work.
import type { ToolSet } from "ai"

import { computerTools } from "@/lib/agent/tools/computer"
import { memoryTools } from "@/lib/agent/tools/memory"
import { sandboxTools } from "@/lib/agent/tools/sandbox"
import type { ToolContext } from "@/lib/agent/tools/shared"
import { webTools } from "@/lib/agent/tools/web"
import { getSandboxProvider, getWebProvider } from "@/lib/providers"

// What the bot can do in this run, for the system prompt.
export type Capabilities = {
  web: boolean
  // Memory needs no outside service, so every bot has it.
  memory: boolean
  // A Linux sandbox of its own (made the first time a tool uses it).
  sandbox: boolean
  // A desktop screen it can look at and use (part of the sandbox).
  computer: boolean
}

export function buildTools(context: ToolContext): {
  tools: ToolSet
  capabilities: Capabilities
} {
  const web = getWebProvider()
  const sandbox = getSandboxProvider()

  return {
    tools: {
      ...memoryTools(context),
      ...(web ? webTools(web, context) : {}),
      ...(sandbox ? sandboxTools(context, sandbox) : {}),
      ...(sandbox ? computerTools(context, sandbox) : {}),
    },
    capabilities: {
      web: web !== null,
      memory: true,
      sandbox: sandbox !== null,
      computer: sandbox !== null,
    },
  }
}
