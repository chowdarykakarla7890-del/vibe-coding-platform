'use client'

import { Button } from '@/components/ui/button'
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import type { ComponentProps } from 'react'

export function Suggestions({
  className,
  children,
  ...props
}: ComponentProps<typeof ScrollArea>) {
  return (
    <ScrollArea className="w-full overflow-x-auto whitespace-nowrap" {...props}>
      <div className={cn('flex w-max flex-nowrap items-center gap-2', className)}>
        {children}
      </div>
      <ScrollBar className="hidden" orientation="horizontal" />
    </ScrollArea>
  )
}

export function Suggestion({
  suggestion,
  onSuggestionClick,
  children,
  className,
  ...props
}: Omit<ComponentProps<typeof Button>, 'onClick'> & {
  suggestion: string
  onSuggestionClick?: (suggestion: string) => void
}) {
  return (
    <Button
      className={cn('h-auto cursor-pointer rounded-lg px-3 py-2 text-left text-xs', className)}
      onClick={() => onSuggestionClick?.(suggestion)}
      type="button"
      variant="outline"
      {...props}
    >
      {children ?? suggestion}
    </Button>
  )
}
