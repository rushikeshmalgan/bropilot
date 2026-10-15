import { BotAvatar } from "@/components/bot-avatar"
import { NewBotButton } from "@/components/bot-dialogs"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"

export function BotEmpty() {
  return (
    <Empty className="text-wrap">
      <EmptyHeader>
        <EmptyMedia className="mb-4">
          <BotAvatar name="Bro Pilot" />
        </EmptyMedia>
        <EmptyTitle>Meet your first bot</EmptyTitle>
        <EmptyDescription>
          Every bot gets its own personality, memory, and face. Spin one up and
          start the conversation.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <NewBotButton />
      </EmptyContent>
    </Empty>
  )
}
