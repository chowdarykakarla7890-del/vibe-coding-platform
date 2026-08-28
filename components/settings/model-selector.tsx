'use client'

import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { BotIcon, CheckIcon, ChevronDownIcon, Loader2Icon } from 'lucide-react'
import { useState, useSyncExternalStore } from 'react'
import { AutoFixErrors } from './auto-fix-errors'
import { ReasoningEffort } from './reasoning-effort'
import {
  type DisplayModel,
  useAvailableModels,
} from './use-available-models'
import { useModelId } from './use-settings'

const subscribeToMount = () => () => undefined
const getClientMountSnapshot = () => true
const getServerMountSnapshot = () => false

export function ModelSelector({ className }: { className?: string }) {
  const [modelId, setModelId] = useModelId()
  const [open, setOpen] = useState(false)
  const mounted = useSyncExternalStore(
    subscribeToMount,
    getClientMountSnapshot,
    getServerMountSnapshot
  )
  const { models: available, isLoading, error } = useAvailableModels()
  const models = available ?? []
  const modelGroups: Array<{
    label: string
    models: DisplayModel[]
    tier: DisplayModel['tier']
  }> = [
    {
      label: 'Primary models',
      models: models.filter((model) => model.tier === 'primary'),
      tier: 'primary',
    },
    {
      label: 'Affordable models',
      models: models.filter((model) => model.tier === 'affordable'),
      tier: 'affordable',
    },
  ]
  const selected = models.find((model) => model.id === modelId)
  const label = selected?.label ?? 'Model'

  if (!mounted) {
    return (
      <Button
        aria-label="Loading models"
        className={cn(
          'h-8 max-w-[180px] gap-1.5 rounded-md border-border bg-secondary/50 px-2 text-xs font-normal text-secondary-foreground',
          className
        )}
        disabled
        size="sm"
        variant="outline"
      >
        <BotIcon className="size-3.5 shrink-0 text-zinc-400" />
        <span>Model</span>
        <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
      </Button>
    )
  }

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button
          className={cn(
            'h-8 max-w-[180px] gap-1.5 rounded-md border-border bg-secondary/50 px-2 text-xs font-normal text-secondary-foreground hover:bg-secondary hover:text-foreground',
            className
          )}
          disabled={isLoading || Boolean(error) || models.length === 0}
          size="sm"
          variant="outline"
        >
          {isLoading ? (
            <Loader2Icon className="size-3.5 shrink-0 animate-spin" />
          ) : (
            <BotIcon className="size-3.5 shrink-0 text-zinc-400" />
          )}
          <span className="truncate">{error ? 'Models unavailable' : label}</span>
          <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 border-border bg-popover p-1.5">
        <div className="border-b border-border px-2.5 py-2">
          <div className="text-xs font-medium text-foreground">Choose a model</div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            This model will power the next tutor response.
          </div>
        </div>
        <div className="max-h-64 overflow-y-auto py-1">
          {modelGroups.map((group) =>
            group.models.length > 0 ? (
              <div key={group.tier}>
                <div className="px-2.5 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  {group.label}
                </div>
                {group.models.map((model) => {
                  const active = model.id === modelId
                  return (
                    <button
                      className={cn(
                        'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs transition-colors hover:bg-secondary',
                        active && 'bg-secondary text-foreground'
                      )}
                      key={model.id}
                      onClick={() => {
                        void setModelId(model.id)
                        setOpen(false)
                      }}
                      type="button"
                    >
                      <BotIcon className="size-3.5 shrink-0 text-zinc-400" />
                      <span className="min-w-0 flex-1 truncate">
                        {model.label}
                      </span>
                      {active && (
                        <CheckIcon className="size-3.5 shrink-0 text-zinc-200" />
                      )}
                    </button>
                  )
                })}
              </div>
            ) : null
          )}
        </div>
        <div className="border-t border-border px-2.5 py-2">
          <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Tutor preferences
          </div>
          <div className="space-y-3 px-1">
            <AutoFixErrors />
            <ReasoningEffort />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
