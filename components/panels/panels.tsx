import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface Props {
  className?: string
  children: ReactNode
}

export function Panel({ className, children }: Props) {
  return (
    <div
      className={cn(
        'relative flex size-full flex-col overflow-hidden rounded-lg border border-border bg-card shadow-none',
        className
      )}
    >
      {children}
    </div>
  )
}

export function PanelHeader({ className, children }: Props) {
  return (
    <div
      className={cn(
        'flex items-center border-b border-border bg-card px-3 py-2 text-sm text-secondary-foreground',
        className
      )}
    >
      {children}
    </div>
  )
}
