// A sandbox is a small Linux computer that belongs to one bot. The app only
// knows this interface; the real one is Daytona (lib/providers/daytona.ts) and
// tests use an in-memory fake.
//
// Nothing here can carry a secret into a sandbox: there is no field for
// environment variables, credentials or mounted secrets on purpose.

// Where a sandbox is, in terms the app cares about.
// - running: commands can be run now
// - stopped: switched off (for example after inactivity); start() brings it back
// - transitioning: starting, stopping or being built; try again shortly
// - deleting: on its way out; it will be missing shortly
// - error: the provider reports it as broken; the owner can reset it
// - missing: the provider no longer has it
export type SandboxState =
  | "running"
  | "stopped"
  | "transitioning"
  | "deleting"
  | "error"
  | "missing"

export type CreateSandboxInput = {
  // Stored as a label on the sandbox so that orphans (made but never
  // recorded) can be found and removed. It is not used for anything else.
  botId: string
  // Minutes without activity before the sandbox switches itself off.
  autoStopMinutes: number
  // How long creating it may take, in seconds.
  timeoutSeconds: number
}

export type CreatedSandbox = {
  id: string
  // The operating system user commands run as, if the provider says.
  user?: string
}

export type ExecOptions = {
  // The command is stopped after this long.
  timeoutSeconds: number
}

export type ExecResult = {
  exitCode: number
  // Standard output and error together, as one string.
  output: string
  timedOut: boolean
}

export type SandboxEntry = {
  name: string
  path: string
  isDir: boolean
  size: number
}

// The desktop inside a sandbox: a virtual screen the bot can look at and use,
// and a viewer the owner can watch it through. See docs/computer-use.md.
// - running: the screen is up and answering
// - starting: its processes are coming up
// - stopped: not started (or the sandbox is off)
// - error: it failed to start or a process died
export type DesktopState = "running" | "starting" | "stopped" | "error"

export type MouseButton = "left" | "right" | "middle"
export type ScrollDirection = "up" | "down" | "left" | "right"

export type ScreenImage = {
  // The image as base64, without a "data:" prefix.
  base64: string
  mediaType: "image/png"
  // In pixels. Click coordinates are in the same pixels, from the top left.
  width: number
  height: number
}

export type ViewerUrlOptions = {
  // How long the address works for.
  expiresInSeconds: number
  // View-only unless the owner has asked to take control.
  viewOnly: boolean
}

export interface DesktopProvider {
  status(id: string): Promise<DesktopState>
  // Resolves once the desktop is running. Rejects (SandboxProviderError) if it
  // can't be started.
  start(id: string): Promise<void>
  screenshot(id: string): Promise<ScreenImage>
  click(
    id: string,
    x: number,
    y: number,
    options?: { button?: MouseButton; double?: boolean }
  ): Promise<void>
  move(id: string, x: number, y: number): Promise<void>
  type(id: string, text: string): Promise<void>
  press(id: string, key: string): Promise<void>
  scroll(
    id: string,
    x: number,
    y: number,
    direction: ScrollDirection,
    amount: number
  ): Promise<void>
  // An address that shows the screen in a browser, made fresh for each call.
  // The only thing handed to the owner; it never contains a credential the
  // app keeps.
  viewerUrl(id: string, options: ViewerUrlOptions): Promise<string>
}

export interface SandboxProvider {
  desktop: DesktopProvider
  create(input: CreateSandboxInput): Promise<CreatedSandbox>
  status(id: string): Promise<SandboxState>
  // Resolves once the sandbox is running. Safe to call on one that already is.
  start(id: string): Promise<void>
  stop(id: string): Promise<void>
  exec(id: string, command: string, options: ExecOptions): Promise<ExecResult>
  // Refuses (SandboxProviderError) a file larger than maxBytes instead of
  // downloading it.
  readFile(id: string, path: string, maxBytes: number): Promise<Buffer>
  writeFile(id: string, path: string, content: Buffer): Promise<void>
  list(id: string, path: string): Promise<SandboxEntry[]>
  // Succeeds if the sandbox is already gone.
  delete(id: string): Promise<void>
  // The IDs of every sandbox labelled with this bot, recorded or not.
  findByBot(botId: string): Promise<string[]>
}

// An error whose message is short and safe to show the model and the user.
// `code` lets callers tell the cases apart without reading the message.
export class SandboxProviderError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "failed" = "failed"
  ) {
    super(message)
    this.name = "SandboxProviderError"
  }
}

export function isSandboxMissing(error: unknown) {
  return error instanceof SandboxProviderError && error.code === "not_found"
}
