import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { botFaceUrl } from "@/lib/bot-faces"

// `seed` is the bot's stored avatar; without one the face comes from the name.
export function BotAvatar({
  name,
  seed,
  size,
  className,
}: {
  name: string
  seed?: string
  size?: React.ComponentProps<typeof Avatar>["size"]
  className?: string
}) {
  return (
    <Avatar size={size} className={className}>
      <AvatarImage src={botFaceUrl(seed ?? name)} alt="" />
      <AvatarFallback>{name.trim().charAt(0).toUpperCase()}</AvatarFallback>
    </Avatar>
  )
}
