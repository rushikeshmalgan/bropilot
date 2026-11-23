"use client"

import {
  BrainIcon,
  CheckIcon,
  ChevronRightIcon,
  FilePenIcon,
  FileTextIcon,
  FolderOpenIcon,
  GlobeIcon,
  MonitorIcon,
  SearchIcon,
  TerminalIcon,
  TriangleAlertIcon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react"

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Spinner } from "@/components/ui/spinner"
import type { ToolPart } from "@/lib/chat-types"
import { cn } from "@/lib/utils"

// How each tool is named and summarised on its card. A tool that isn't listed
// still gets a card, with its own name and no summary.
const TOOLS: Record<
  string,
  { label: string; icon: LucideIcon; summary: (input: Fields) => string }
> = {
  webSearch: {
    label: "Searched the web",
    icon: SearchIcon,
    summary: (input) => text(input.query),
  },
  scrapePage: {
    label: "Read a page",
    icon: GlobeIcon,
    summary: (input) => text(input.url),
  },
  bash: {
    label: "Ran a command",
    icon: TerminalIcon,
    summary: (input) => text(input.command).split("\n")[0],
  },
  readFile: {
    label: "Read a file",
    icon: FileTextIcon,
    summary: (input) => text(input.path),
  },
  writeFile: {
    label: "Saved a file",
    icon: FilePenIcon,
    summary: (input) => text(input.path),
  },
  listFiles: {
    label: "Listed files",
    icon: FolderOpenIcon,
    summary: (input) => text(input.path) || "home folder",
  },
  computer: {
    label: "Used the screen",
    icon: MonitorIcon,
    summary: (input) => describeScreenAction(input),
  },
  memoryList: {
    label: "Looked through memory",
    icon: BrainIcon,
    summary: () => "",
  },
  memoryRead: {
    label: "Read from memory",
    icon: BrainIcon,
    summary: (input) => text(input.path),
  },
  memoryWrite: {
    label: "Saved to memory",
    icon: BrainIcon,
    summary: (input) => text(input.path),
  },
}

type Fields = Record<string, unknown>

function fields(value: unknown): Fields {
  return typeof value === "object" && value !== null ? (value as Fields) : {}
}

function text(value: unknown) {
  return typeof value === "string" ? value : ""
}

// "click (120, 340)", "type "hello"", "key Return" and so on.
function describeScreenAction(input: Fields) {
  const action = text(input.action)
  const at =
    typeof input.x === "number" && typeof input.y === "number"
      ? ` (${input.x}, ${input.y})`
      : ""

  if (action === "type") {
    const typed = text(input.text)
    return `type "${typed.length > 40 ? `${typed.slice(0, 40)}…` : typed}"`
  }
  if (action === "key") {
    return `key ${text(input.key)}`
  }
  return `${action.replace("_", " ")}${at}`
}

// What a card shows under "Sent". Commands and files read better as plain
// text than as JSON with escaped line breaks.
function sentText(name: string, input: unknown) {
  const fields_ = fields(input)
  if (name === "bash" && typeof fields_.command === "string") {
    return fields_.command
  }
  if (name === "writeFile" && typeof fields_.content === "string") {
    return `${text(fields_.path)}\n\n${fields_.content}`
  }
  return pretty(input)
}

// The same for what came back.
function resultText(name: string, output: unknown) {
  const result = fields(output)
  if (name === "bash" && typeof result.output === "string") {
    const header =
      result.timedOut === true
        ? "stopped: time limit"
        : `exit code ${String(result.exitCode)}`
    return `${header}\n${result.output}`
  }
  if (name === "readFile" && typeof result.content === "string") {
    return result.content
  }
  if (name === "computer" && typeof result.screen === "object") {
    const size = fields(result.screen)
    return `Done. The screen is ${String(size.width)} by ${String(size.height)} pixels. The picture is shown live in the screen panel and isn't saved here.`
  }
  return pretty(output)
}

function pretty(value: unknown) {
  if (typeof value === "string") {
    return value
  }
  try {
    return JSON.stringify(value, null, 2) ?? ""
  } catch {
    return ""
  }
}

// One tool call inside a reply: a single line that opens to show what was
// sent and what came back.
export function ToolCard({
  part,
  interrupted = false,
}: {
  part: ToolPart
  // The reply ended while this call was still going (the user pressed Stop).
  interrupted?: boolean
}) {
  const known = TOOLS[part.name]
  const Icon = known?.icon ?? WrenchIcon
  const summary = known?.summary(fields(part.input)) ?? ""
  const output = fields(part.output)
  const failed = part.state === "error"
  const running = part.state === "running" && !interrupted
  const stopped = part.state === "running" && interrupted

  return (
    <Collapsible className="w-full rounded-lg border bg-background/60 text-xs">
      <CollapsibleTrigger className="group/tool flex w-full items-center gap-2 px-2.5 py-1.5 text-left">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-medium">
          {known?.label ?? part.name}
        </span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {summary}
        </span>
        {running && <Spinner className="size-3.5 shrink-0" />}
        {stopped && (
          <span className="shrink-0 text-muted-foreground">Stopped</span>
        )}
        {part.state === "done" && (
          <CheckIcon
            aria-label="Finished"
            className="size-3.5 shrink-0 text-muted-foreground"
          />
        )}
        {failed && (
          <TriangleAlertIcon
            aria-label="Failed"
            className="size-3.5 shrink-0 text-destructive"
          />
        )}
        <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]/tool:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-2 border-t px-2.5 py-2">
          <Section title="Sent" icon={FileTextIcon}>
            {sentText(part.name, part.input)}
          </Section>
          {part.state !== "running" && (
            <Section
              title={failed ? "Error" : "Result"}
              icon={failed ? TriangleAlertIcon : CheckIcon}
              tone={failed ? "error" : undefined}
            >
              {failed
                ? text(output.error) || "The tool call failed."
                : resultText(part.name, part.output)}
            </Section>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function Section({
  title,
  icon: Icon,
  tone,
  children,
}: {
  title: string
  icon: LucideIcon
  tone?: "error"
  children: string
}) {
  return (
    <div className="flex flex-col gap-1">
      <span
        className={cn(
          "flex items-center gap-1 text-muted-foreground",
          tone === "error" && "text-destructive"
        )}
      >
        <Icon className="size-3" />
        {title}
      </span>
      <pre className="max-h-48 overflow-auto rounded-md bg-muted/60 p-2 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap">
        {children}
      </pre>
    </div>
  )
}
