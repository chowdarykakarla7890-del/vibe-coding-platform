'use client'

import Editor, { DiffEditor, loader, type EditorProps, type DiffEditorProps } from '@monaco-editor/react'
import { useEffect, useState, type ReactNode } from 'react'
import { MONACO_ASSET_PATH, MONACO_LOAD_TIMEOUT_MS } from '@/lib/editor/runtime'

// Configure before any editor mounts; the upstream default fetches a different
// version from a third-party CDN. Editor and diff must share this singleton.
loader.config({ paths: { vs: MONACO_ASSET_PATH } })

function RuntimeGate({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading')
  useEffect(() => {
    let active = true
    let settled = false
    function finish(value: 'ready' | 'unavailable') {
      if (!active || settled) return
      settled = true
      clearTimeout(timer)
      setStatus(value)
    }
    const timer = setTimeout(() => finish('unavailable'), MONACO_LOAD_TIMEOUT_MS)
    // init() shares its promise with other mounted editors. Do not cancel that
    // shared work on unmount, and never print an opaque loader error payload.
    try { void loader.init().then(() => finish('ready'), () => finish('unavailable')) }
    catch { finish('unavailable') }
    return () => { active = false; clearTimeout(timer) }
  }, [])

  if (status === 'ready') return children
  if (status === 'loading') return <div className="flex h-full items-center justify-center gap-2 text-sm text-zinc-300" role="status">
    <span aria-hidden="true" className="size-4 rounded-full border-2 border-current border-r-transparent motion-safe:animate-spin" />
    Loading code editor…
  </div>
  return <div className="flex h-full min-h-0 flex-col">
    <p role="status" className="border-b border-white/10 p-3 text-xs leading-5 text-zinc-300">
      The advanced editor could not load. Basic mode keeps your file available. Save or copy your draft before reloading to retry the advanced editor.
    </p>
    {fallback}
  </div>
}

type CodeEditorProps = Omit<EditorProps, 'onChange'> & {
  onChange?: (value: string | undefined) => void
  onSave?: () => void
}

export default function MonacoEditor({ onSave, ...props }: CodeEditorProps) {
  return <RuntimeGate fallback={<textarea
    aria-label="Source editor (basic mode)"
    className="min-h-0 flex-1 resize-none bg-[#0d1117] p-3 font-mono text-sm text-zinc-100 outline-offset-[-2px]"
    spellCheck={false}
    readOnly={props.options?.readOnly}
    value={props.value ?? ''}
    onChange={event => props.onChange?.(event.target.value)}
    onKeyDown={event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        if (!props.options?.readOnly) onSave?.()
      }
    }}
  />}><Editor {...props} /></RuntimeGate>
}

export function MonacoDiffEditor(props: DiffEditorProps) {
  return <RuntimeGate fallback={<div className="grid min-h-0 flex-1 grid-cols-2 gap-px bg-white/10">
    <label className="flex min-h-0 min-w-0 flex-col bg-[#0d1117] p-2 text-xs text-zinc-300">Saved version
      <textarea aria-label="Saved version (basic comparison)" className="min-h-0 flex-1 resize-none bg-transparent p-2 font-mono text-sm text-zinc-100" readOnly value={props.original ?? ''} />
    </label>
    <label className="flex min-h-0 min-w-0 flex-col bg-[#0d1117] p-2 text-xs text-zinc-300">Your draft
      <textarea aria-label="Your draft (basic comparison)" className="min-h-0 flex-1 resize-none bg-transparent p-2 font-mono text-sm text-zinc-100" readOnly value={props.modified ?? ''} />
    </label>
  </div>}><DiffEditor {...props} /></RuntimeGate>
}
