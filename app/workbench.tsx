'use client'

import { FileExplorer } from './file-explorer'
import { Logs } from './logs'
import { Preview } from './preview'
import { Button } from '@/components/ui/button'
import { Code2Icon, EyeIcon } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { SourceRecovery } from '@/components/workspace/source-recovery'
import { SandboxStop } from '@/components/workspace/sandbox-stop'

type WorkspaceTab = 'code' | 'preview'

export function Workbench({ className }: { className?: string }) {
  const [tab, setTab] = useState<WorkspaceTab>('code')

  return (
    <section
      className={cn(
        'flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card shadow-none',
        className
      )}
    >
      <div className="flex h-10 items-center gap-1 border-b border-border bg-card px-2">
        <WorkspaceTabButton
          active={tab === 'code'}
          icon={<Code2Icon className="size-3.5" />}
          label="Code"
          onClick={() => setTab('code')}
        />
        <WorkspaceTabButton
          active={tab === 'preview'}
          icon={<EyeIcon className="size-3.5" />}
          label="Preview"
          onClick={() => setTab('preview')}
        />
        <div className="ml-auto"><SandboxStop /></div>
        <div className="rounded-md border border-border bg-secondary px-2 py-1 font-mono text-[10px] text-muted-foreground">
          ⌘S to save
        </div>
      </div>

      <SourceRecovery />
      <div className="min-h-0 flex-[7] p-2 pb-0">
        {/* Keep the editor mounted: its draft and pending save belong to this
            workspace even while the preview is visible. */}
        <div className="h-full" hidden={tab !== 'code'}>
          <FileExplorer className="h-full" />
        </div>
        {tab === 'preview' ? <Preview className="h-full" /> : null}
      </div>
      <div className="min-h-[180px] flex-[3] p-2">
        <Logs className="h-full" />
      </div>
    </section>
  )
}

function WorkspaceTabButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean
  icon: React.ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <Button
      className={cn(
        'h-7 gap-1.5 rounded-md px-2.5 font-mono text-xs',
        active
          ? 'bg-secondary text-foreground hover:bg-secondary'
          : 'text-muted-foreground hover:text-foreground'
      )}
      onClick={onClick}
      aria-pressed={active}
      size="sm"
      variant="ghost"
    >
      {icon}
      {label}
    </Button>
  )
}
