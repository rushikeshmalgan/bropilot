import { formatTokens } from "@/lib/plans"
import type { UsageSummary } from "@/lib/usage"
import { cn } from "@/lib/utils"

// One line of the sidebar footer: what is left of a limit, with a thin bar.
function Line({
  label,
  used,
  max,
  format = String,
}: {
  label: string
  used: number
  max: number
  format?: (value: number) => string
}) {
  const share = max > 0 ? Math.min(1, used / max) : 1
  const full = used >= max

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className={cn("tabular-nums", full && "text-destructive")}>
          {format(used)} of {format(max)}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={Math.min(used, max)}
        className="h-1 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn(
            "h-full rounded-full bg-foreground/60",
            full && "bg-destructive"
          )}
          style={{ width: `${Math.round(share * 100)}%` }}
        />
      </div>
    </div>
  )
}

// What the user has used this month and what their plan allows. Shown in the
// sidebar footer, and hidden when the sidebar is collapsed to icons.
export function UsageMeter({ usage }: { usage: UsageSummary }) {
  return (
    <div className="flex flex-col gap-2 px-1.5 group-data-[collapsible=icon]:hidden">
      <div className="flex items-baseline justify-between text-xs">
        <span className="font-medium">{usage.plan} plan</span>
        <span className="text-muted-foreground">this month</span>
      </div>
      <Line label="Replies" used={usage.runs.used} max={usage.runs.max} />
      <Line
        label="Tokens"
        used={usage.tokens.used}
        max={usage.tokens.max}
        format={formatTokens}
      />
      <Line label="Bots" used={usage.bots.used} max={usage.bots.max} />
    </div>
  )
}
