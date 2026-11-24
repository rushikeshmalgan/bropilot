import Link from "next/link"

import { BotAvatar } from "@/components/bot-avatar"
import { NewBotButton } from "@/components/bot-dialogs"
import { buttonVariants } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"

// The home page for someone who has bots: no chat is open, so the one thing to
// do is open one. The newest bot is offered; the sidebar has the rest.
export function BotPicker({
  bot,
}: {
  bot: { id: string; name: string; job: string; avatar: string }
}) {
  return (
    <Empty className="text-wrap">
      <EmptyHeader>
        <EmptyMedia className="mb-4">
          <BotAvatar name={bot.name} seed={bot.avatar} />
        </EmptyMedia>
        <EmptyTitle>Who do you want to talk to?</EmptyTitle>
        <EmptyDescription>
          Pick a bot from the sidebar, or carry on with {bot.name}, your newest
          bot.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <div className="flex flex-wrap justify-center gap-2">
          <Link href={`/bot/${bot.id}`} prefetch={false} className={buttonVariants()}>
            Talk to {bot.name}
          </Link>
          <NewBotButton />
        </div>
      </EmptyContent>
    </Empty>
  )
}
