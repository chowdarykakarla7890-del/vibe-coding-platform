import { cn } from '@/lib/utils'
import { BotIcon } from 'lucide-react'
import { ProjectSwitcher } from '@/components/platform/project-switcher'
import { SignOut } from '@/components/auth/sign-out'

interface Props {
  className?: string
}

export function Header({ className }: Props) {
  return (
    <header className={cn('flex items-center justify-between', className)}>
      <div className="flex min-w-0 flex-1 items-center gap-2 pr-2 sm:gap-3">
        <div className="grid size-7 shrink-0 place-items-center rounded-md border border-border bg-secondary text-foreground">
          <BotIcon className="size-4" />
        </div>
        <div className="hidden text-sm font-medium tracking-tight sm:block">CodeTutor</div>
        <ProjectSwitcher />
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <SignOut />
        <div className="hidden items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 font-mono text-[10px] text-muted-foreground sm:flex">
          <span className="size-1.5 rounded-full bg-zinc-400" /> Local
        </div>
      </div>
    </header>
  )
}
