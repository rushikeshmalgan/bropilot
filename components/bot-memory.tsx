"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { BrainIcon, FileTextIcon, PlusIcon, Trash2Icon } from "lucide-react"

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import {
  deleteMemoryFile,
  readMemoryFile,
  saveMemoryFile,
} from "@/lib/actions"
import { cn } from "@/lib/utils"

export type MemoryListItem = {
  path: string
  version: number
  size: number
}

type Draft = {
  path: string
  content: string
  // The version that was loaded; null for a file that hasn't been saved yet.
  version: number | null
}

type BotMemoryProps = {
  botId: string
  botName: string
  files: MemoryListItem[]
  maxFiles: number
  maxFileChars: number
}

// The bot's memory files: pick one to read or edit it, add one, delete one.
export function BotMemory({
  botId,
  botName,
  files: initialFiles,
  maxFiles,
  maxFileChars,
}: BotMemoryProps) {
  const router = useRouter()
  const [files, setFiles] = React.useState(initialFiles)
  const [draft, setDraft] = React.useState<Draft | null>(null)
  // What the draft looked like when it was loaded, to tell if it was edited.
  const [loaded, setLoaded] = React.useState<Draft | null>(null)
  const [opening, setOpening] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const [problem, setProblem] = React.useState<{
    text: string
    conflict: boolean
  } | null>(null)

  // A fresh list from the server replaces ours (for example after the bot
  // saved something in a chat and this page was reloaded).
  const [serverFiles, setServerFiles] = React.useState(initialFiles)
  if (initialFiles !== serverFiles) {
    setServerFiles(initialFiles)
    setFiles(initialFiles)
  }

  const isNew = draft !== null && draft.version === null
  const dirty =
    draft !== null &&
    (loaded === null ||
      draft.content !== loaded.content ||
      draft.path !== loaded.path)
  const tooLong = (draft?.content.length ?? 0) > maxFileChars
  const full = files.length >= maxFiles

  async function open(path: string) {
    setProblem(null)
    setOpening(path)
    const result = await readMemoryFile(botId, path)
    setOpening(null)

    if ("error" in result) {
      setProblem({ text: result.error, conflict: false })
      return
    }

    const next = {
      path: result.file.path,
      content: result.file.content,
      version: result.file.version,
    }
    setDraft(next)
    setLoaded(next)
  }

  function startNew() {
    setProblem(null)
    setLoaded(null)
    setDraft({
      path: files.some((file) => file.path === "index.md") ? "" : "index.md",
      content: "",
      version: null,
    })
  }

  async function save() {
    if (!draft || saving) {
      return
    }

    setProblem(null)
    setSaving(true)
    const path = draft.path.trim()
    const result = await saveMemoryFile(botId, {
      path,
      content: draft.content,
      expectedVersion: draft.version,
    })
    setSaving(false)

    if ("error" in result) {
      setProblem({ text: result.error, conflict: result.conflict === true })
      return
    }

    const saved = { path: result.path, content: draft.content, version: result.version }
    setDraft(saved)
    setLoaded(saved)
    setFiles((current) =>
      [
        ...current.filter((file) => file.path !== saved.path),
        { path: saved.path, version: saved.version, size: saved.content.length },
      ].sort((a, b) => a.path.localeCompare(b.path))
    )
    router.refresh()
  }

  async function remove() {
    if (!draft || draft.version === null) {
      return
    }

    setDeleting(true)
    const result = await deleteMemoryFile(botId, draft.path)
    setDeleting(false)
    setConfirmDelete(false)

    if ("error" in result) {
      setProblem({ text: result.error, conflict: false })
      return
    }

    setFiles((current) => current.filter((file) => file.path !== draft.path))
    setDraft(null)
    setLoaded(null)
    router.refresh()
  }

  if (files.length === 0 && !draft) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia>
            <BrainIcon className="size-6 text-muted-foreground" />
          </EmptyMedia>
          <EmptyTitle>No memories yet</EmptyTitle>
          <EmptyDescription>
            {botName} saves notes here when you ask it to remember something.
            You can also write one yourself.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="secondary" onClick={startNew}>
            <PlusIcon data-icon="inline-start" />
            New memory file
          </Button>
        </EmptyContent>
      </Empty>
    )
  }

  return (
    <div className="flex flex-col gap-4 md:flex-row">
      <div className="flex shrink-0 flex-col gap-2 md:w-60">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            {files.length} of {maxFiles} files
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={startNew}
            disabled={full}
            title={full ? "Delete a file to make room for a new one." : undefined}
          >
            <PlusIcon data-icon="inline-start" />
            New
          </Button>
        </div>
        <ul className="flex flex-col gap-0.5">
          {files.map((file) => (
            <li key={file.path}>
              <button
                type="button"
                onClick={() => open(file.path)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted",
                  draft?.path === file.path && !isNew && "bg-muted font-medium"
                )}
              >
                {opening === file.path ? (
                  <Spinner className="size-3.5 shrink-0" />
                ) : (
                  <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1 truncate">{file.path}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {file.size.toLocaleString()}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {draft ? (
          <>
            {isNew ? (
              <Input
                aria-label="File path"
                placeholder="notes.md or people/rushi.md"
                value={draft.path}
                maxLength={120}
                onChange={(event) =>
                  setDraft({ ...draft, path: event.target.value })
                }
              />
            ) : (
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-sm font-medium">
                  {draft.path}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  version {draft.version}
                </span>
              </div>
            )}

            <Textarea
              aria-label="File content"
              value={draft.content}
              onChange={(event) =>
                setDraft({ ...draft, content: event.target.value })
              }
              className="min-h-64 font-mono text-sm"
              placeholder="What should the bot remember?"
            />

            <div className="flex flex-wrap items-center justify-between gap-2">
              <span
                className={cn(
                  "text-xs text-muted-foreground",
                  tooLong && "text-destructive"
                )}
              >
                {draft.content.length.toLocaleString()} of{" "}
                {maxFileChars.toLocaleString()} characters
              </span>
              <div className="flex items-center gap-2">
                {!isNew && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setConfirmDelete(true)}
                  >
                    <Trash2Icon data-icon="inline-start" />
                    Delete
                  </Button>
                )}
                <Button
                  size="sm"
                  onClick={save}
                  disabled={saving || !dirty || tooLong || !draft.path.trim()}
                >
                  {saving && <Spinner data-icon="inline-start" />}
                  Save
                </Button>
              </div>
            </div>

            {problem && (
              <div
                role="alert"
                className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                <span>{problem.text}</span>
                {problem.conflict && !isNew && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => open(draft.path)}
                  >
                    Load the latest
                  </Button>
                )}
              </div>
            )}
          </>
        ) : (
          <>
            <p className="rounded-md border border-dashed px-3 py-8 text-center text-sm text-muted-foreground">
              Pick a file to read or edit it.
            </p>
            {problem && (
              <p role="alert" className="text-sm text-destructive">
                {problem.text}
              </p>
            )}
          </>
        )}
      </div>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this memory file?</AlertDialogTitle>
            <AlertDialogDescription>
              {botName} will no longer remember what is in {draft?.path}. This
              can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button variant="destructive" disabled={deleting} onClick={remove}>
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
