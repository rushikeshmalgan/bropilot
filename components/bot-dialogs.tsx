"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { PlusIcon, ShuffleIcon } from "lucide-react"

import { BotAvatar } from "@/components/bot-avatar"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { toast } from "@/components/ui/toast"
import { createBot } from "@/lib/actions"

export type SidebarBot = {
  id: string
  name: string
  job: string
  ago: string
}

type BotDialogs = {
  bots: SidebarBot[]
  openNewBot: () => void
  openNewGroup: () => void
}

const BotDialogsContext = React.createContext<BotDialogs | null>(null)

export function useBotDialogs() {
  const context = React.useContext(BotDialogsContext)
  if (!context) {
    throw new Error("useBotDialogs must be used within a BotDialogsProvider.")
  }

  return context
}

const JOB_SUGGESTIONS = [
  "Research assistant",
  "Code reviewer",
  "Writing editor",
  "Tutor",
]

function newFaceSeed() {
  return crypto.randomUUID().slice(0, 8)
}

export function BotDialogsProvider({
  bots,
  children,
}: {
  bots: SidebarBot[]
  children: React.ReactNode
}) {
  const [newBotOpen, setNewBotOpen] = React.useState(false)
  const [newGroupOpen, setNewGroupOpen] = React.useState(false)

  const value = React.useMemo<BotDialogs>(
    () => ({
      bots,
      openNewBot: () => setNewBotOpen(true),
      openNewGroup: () => setNewGroupOpen(true),
    }),
    [bots]
  )

  return (
    <BotDialogsContext.Provider value={value}>
      {children}
      <Dialog open={newBotOpen} onOpenChange={setNewBotOpen}>
        <DialogContent className="sm:max-w-lg">
          <NewBotForm onDone={() => setNewBotOpen(false)} />
        </DialogContent>
      </Dialog>
      <Dialog open={newGroupOpen} onOpenChange={setNewGroupOpen}>
        <DialogContent>
          <NewGroupForm onDone={() => setNewGroupOpen(false)} />
        </DialogContent>
      </Dialog>
    </BotDialogsContext.Provider>
  )
}

export function NewBotButton({
  children = "Create a new bot",
  ...props
}: React.ComponentProps<typeof Button>) {
  const { openNewBot } = useBotDialogs()

  return (
    <Button variant="secondary" onClick={openNewBot} {...props}>
      <PlusIcon data-icon="inline-start" />
      {children}
    </Button>
  )
}

// The form lives inside the dialog content, so closing the dialog unmounts it
// and the next open starts empty.
function NewBotForm({ onDone }: { onDone: () => void }) {
  const router = useRouter()
  const [name, setName] = React.useState("")
  const [job, setJob] = React.useState("")
  const [instructions, setInstructions] = React.useState("")
  const [avatar, setAvatar] = React.useState(newFaceSeed)
  const [error, setError] = React.useState<string | null>(null)
  const [pending, startTransition] = React.useTransition()

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)

    startTransition(async () => {
      const result = await createBot({ name, job, instructions, avatar })

      if ("error" in result) {
        setError(result.error)
        return
      }

      onDone()
      router.push(`/chat/${result.id}`)
    })
  }

  return (
    <form onSubmit={onSubmit} className="contents">
      <DialogHeader>
        <DialogTitle>New bot</DialogTitle>
        <DialogDescription>Give it a face, a name, and a job to do.</DialogDescription>
      </DialogHeader>

      <div className="flex flex-wrap gap-2">
        {JOB_SUGGESTIONS.map((suggestion) => (
          <Button
            key={suggestion}
            type="button"
            variant="outline"
            size="sm"
            className="rounded-full px-3 text-sm dark:bg-input/30"
            onClick={() => setJob(suggestion)}
          >
            {suggestion}
          </Button>
        ))}
      </div>

      <div className="mb-3 flex items-center gap-4">
        <div className="flex size-12 shrink-0 items-center justify-center">
          <BotAvatar name={name || "Bot"} size="lg" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-medium">Face</span>
          <span className="text-sm text-muted-foreground">
            Shuffle until you find one you like.
          </span>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="text-sm"
          onClick={() => setAvatar(newFaceSeed())}
        >
          <ShuffleIcon data-icon="inline-start" />
          Shuffle
        </Button>
      </div>

      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="bot-name">Name</FieldLabel>
          <Input
            id="bot-name"
            placeholder="Ada"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={60}
            required
            autoFocus
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="bot-job">Job</FieldLabel>
          <Input
            id="bot-job"
            placeholder="Research assistant"
            value={job}
            onChange={(event) => setJob(event.target.value)}
            maxLength={100}
            required
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="bot-instructions">How it should work</FieldLabel>
          <Textarea
            id="bot-instructions"
            placeholder="Answer briefly, cite sources, and ask before running anything destructive."
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            maxLength={2000}
            className="min-h-24"
          />
        </Field>
        {error && <FieldError>{error}</FieldError>}
      </FieldGroup>

      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>
          Cancel
        </DialogClose>
        <Button type="submit" disabled={pending}>
          {pending && <Spinner data-icon="inline-start" />}
          Create bot
        </Button>
      </DialogFooter>
    </form>
  )
}

function NewGroupForm({ onDone }: { onDone: () => void }) {
  const { bots } = useBotDialogs()
  const [name, setName] = React.useState("")
  const [selected, setSelected] = React.useState<string[]>([])

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()

    // There is no table for group chats yet, so say so instead of pretending.
    toast.add({
      title: "Group chats aren't saved yet",
      description: "Bots work one-on-one for now.",
    })
    onDone()
  }

  return (
    <form onSubmit={onSubmit} className="contents">
      <DialogHeader>
        <DialogTitle>New group chat</DialogTitle>
        <DialogDescription>
          Name the group and pick which bots are in it.
        </DialogDescription>
      </DialogHeader>

      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="group-name">Name</FieldLabel>
          <Input
            id="group-name"
            placeholder="Weekend plans"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={60}
            required
            autoFocus
          />
        </Field>
        <Field>
          <FieldLabel>Bots</FieldLabel>
          <div className="flex flex-col gap-4">
            {bots.length === 0 && (
              <p className="text-sm text-muted-foreground">
                Create a bot first, then add it to a group.
              </p>
            )}
            {[...bots].reverse().map((bot) => (
              <label key={bot.id} className="flex items-center gap-3 text-sm">
                <Checkbox
                  checked={selected.includes(bot.id)}
                  onCheckedChange={(checked) =>
                    setSelected((current) =>
                      checked
                        ? [...current, bot.id]
                        : current.filter((id) => id !== bot.id)
                    )
                  }
                />
                <BotAvatar name={bot.name} className="size-4.5" />
                {bot.name}
              </label>
            ))}
          </div>
        </Field>
      </FieldGroup>

      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>
          Cancel
        </DialogClose>
        <Button type="submit">Create group</Button>
      </DialogFooter>
    </form>
  )
}
