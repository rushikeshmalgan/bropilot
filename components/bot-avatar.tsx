import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"

// Every bot shows the project's favicon until bots get generated faces.
export function BotAvatar({
  name,
  size,
  className,
}: {
  name: string
  size?: React.ComponentProps<typeof Avatar>["size"]
  className?: string
}) {
  return (
    <Avatar size={size} className={className}>
      <AvatarImage src="/favicon.ico" alt="" />
      <AvatarFallback>{name.trim().charAt(0).toUpperCase()}</AvatarFallback>
    </Avatar>
  )
}
