'use client'

import { CompassIcon, LoaderCircleIcon, RefreshCwIcon } from 'lucide-react'
import { Panel, PanelHeader } from '@/components/panels/panels'
import { useEffect, useState } from 'react'
import { previewOriginSchema } from '@/lib/sandbox/preview'
import { cn } from '@/lib/utils'

interface Props {
  className?: string
  disabled?: boolean
  url?: string
  loading?: boolean
  error?: string
  ports?: number[]
  port?: number
  onPortChange?: (port: number) => void
  onReconnect?: () => void
}

export function Preview(props: Props) {
  return <PreviewFrame key={`${props.url ?? 'empty'}:${Boolean(props.disabled)}`} {...props} />
}

function PreviewFrame({ className, disabled, url, loading, error: connectionError, ports, port, onPortChange, onReconnect }: Props) {
  const result = previewOriginSchema.safeParse(url)
  const currentUrl = result.success ? result.data : undefined
  const [frameError, setFrameError] = useState<string>()
  const [isLoading, setIsLoading] = useState(Boolean(currentUrl))
  const [refreshKey, setRefreshKey] = useState(0)
  const error = connectionError ?? frameError ?? (url && !currentUrl ? 'This preview address is not a valid sandbox origin. Reconnect to verify it.' : undefined)
  const busy = Boolean(loading || isLoading) && !disabled && !error

  useEffect(() => {
    if (!currentUrl || disabled || loading || !isLoading) return
    const timer = setTimeout(() => {
      setIsLoading(false)
      setFrameError('The preview did not finish loading. Check that your web server is running on the selected port, then retry.')
    }, 20_000)
    return () => clearTimeout(timer)
  }, [currentUrl, disabled, loading, isLoading, refreshKey])

  function refresh() {
    if (disabled) return
    setFrameError(undefined)
    if (onReconnect) onReconnect()
    else if (currentUrl) {
      setIsLoading(true)
      setRefreshKey(key => key + 1)
    }
  }

  return <Panel className={className}>
    <PanelHeader className="min-w-0 gap-2">
      {currentUrl && !disabled && !loading && !connectionError ? <a
        aria-label="Open preview in a new tab"
        className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        href={currentUrl} rel="noopener noreferrer" target="_blank"
      ><CompassIcon className="size-4" /></a> : <CompassIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />}
      <button aria-label="Reconnect preview" type="button" onClick={refresh} disabled={disabled || loading || (!currentUrl && !onReconnect)}
        className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40">
        <RefreshCwIcon className={cn('size-4', busy && 'motion-safe:animate-spin')} />
      </button>
      <input aria-label="Preview URL" readOnly type="text" value={disabled ? '' : currentUrl ?? ''}
        placeholder="Owned sandbox preview" onClick={event => event.currentTarget.select()}
        className="h-7 min-w-0 flex-1 rounded border border-border bg-secondary px-2 font-mono text-xs text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring" />
      {ports && port !== undefined ? <select aria-label="Preview port" value={port} disabled={disabled || loading} onChange={event => onPortChange?.(Number(event.target.value))}
        className="h-7 max-w-24 shrink-0 rounded border border-border bg-secondary px-1 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-ring">
        {ports.map(value => <option key={value} value={value}>{value}</option>)}
      </select> : null}
    </PanelHeader>
    <div className="relative min-h-0 flex-1 bg-background">
      {currentUrl && !disabled && !loading && !connectionError ? <iframe
        className="h-full w-full border-0" key={refreshKey}
        onError={() => { setIsLoading(false); setFrameError('Failed to load the preview. Check the server and reconnect.') }}
        onLoad={() => { setIsLoading(false); setFrameError(undefined) }}
        referrerPolicy="no-referrer" sandbox="allow-downloads allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
        src={currentUrl} title="Sandbox preview"
      /> : <div className="grid h-full place-items-center p-6 text-center font-mono text-xs text-muted-foreground">
        {disabled ? 'This sandbox has stopped. Restore it to reopen the preview.' : 'Create a sandbox, then run a web server on an exposed port to open its preview here.'}
      </div>}
      {busy ? <div role="status" aria-live="polite" className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/90">
        <LoaderCircleIcon aria-hidden="true" className="size-5 motion-safe:animate-spin" />
        <span className="text-xs text-muted-foreground">{loading ? 'Connecting to your sandbox…' : 'Loading preview…'}</span>
      </div> : null}
      {error && !disabled ? <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/95 p-6 text-center">
        <p role="alert" className="text-sm">{error}</p>
        <button className="rounded border border-border px-3 py-1.5 text-xs hover:bg-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" onClick={refresh} type="button">Retry preview</button>
      </div> : null}
    </div>
  </Panel>
}
