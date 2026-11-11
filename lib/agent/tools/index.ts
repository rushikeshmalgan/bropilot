// The tools a bot has for one run. A tool is only offered when the service
// behind it is configured, so the model never sees a tool that can't work.
import type { ToolSet } from "ai"

import { memoryTools } from "@/lib/agent/tools/memory"
import type { ToolContext } from "@/lib/agent/tools/shared"
import { webTools } from "@/lib/agent/tools/web"
import { getWebProvider } from "@/lib/providers"

// What the bot can do in this run, for the system prompt.
export type Capabilities = {
  web: boolean
  // Memory needs no outside service, so every bot has it.
  memory: boolean
}

export function buildTools(context: ToolContext): {
  tools: ToolSet
  capabilities: Capabilities
} {
  const web = getWebProvider()

  return {
    tools: {
      ...memoryTools(context),
      ...(web ? webTools(web, context) : {}),
    },
    capabilities: { web: web !== null, memory: true },
  }
}
