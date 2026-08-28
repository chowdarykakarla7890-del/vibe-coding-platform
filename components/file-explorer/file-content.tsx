'use client'

import type { OnMount } from '@monaco-editor/react'
import { Button } from '@/components/ui/button'
import { CheckIcon, Columns2Icon, FileCode2Icon, RotateCcwIcon, SaveIcon } from 'lucide-react'
import dynamic from 'next/dynamic'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { PulseLoader } from 'react-spinners'
import { toast } from 'sonner'
import { readApiErrorMessage } from '@/lib/api-error'
import { cloudOperation } from '@/lib/learning/cloud-request'
import { sourceReceiptSchema, sourceRevisionSchema } from '@/lib/source-version'
import { readWithDeadline } from '@/lib/abortable-read'
import { awaitMutationReceipt, MutationReceiptTimeoutError } from '@/lib/mutation-receipt'

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center">
      <PulseLoader className="opacity-60" size={8} />
    </div>
  ),
})

const MonacoDiffEditor = dynamic(
  () => import('@monaco-editor/react').then((module) => module.DiffEditor),
  { ssr: false }
)

interface Props {
  sandboxId: string
  path: string
  readOnly?: boolean
  sourceUpdate?: { path: string; revision: number; deleted: boolean; sequence: number }
  onSaved?: (path: string, content: string) => void
  onDirtyChange?: (dirty: boolean) => void
}

export const FileContent = memo(function FileContent(props: Props) {
  return <FileEditor key={`${props.sandboxId}:${props.path}`} {...props} />
})

function FileEditor({
  sandboxId,
  path,
  readOnly = false,
  sourceUpdate,
  onSaved,
  onDirtyChange,
}: Props) {
  const searchParams = new URLSearchParams({ path })
  const endpoint = `/api/sandboxes/${sandboxId}/files?${searchParams.toString()}`
  const [draft, setDraft] = useState('')
  const [savedValue, setSavedValue] = useState('')
  const [revision, setRevision] = useState<number>()
  const revisionRef = useRef<number>(-1)
  const [deleted, setDeleted] = useState(false)
  const [loadError, setLoadError] = useState<string>()
  const [retry, setRetry] = useState(0)
  const [conflict, setConflict] = useState(false)
  const [saveUnconfirmed, setSaveUnconfirmed] = useState(false)
  const [comparing, setComparing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [mode, setMode] = useState<'editor' | 'changes'>('editor')
  const saveRef = useRef<() => void>(() => undefined)
  const savedValueRef = useRef('')
  const draftRef = useRef('')
  const dirtyRef = useRef(false)
  const savingRef = useRef(false)
  const requests = useRef(new Set<AbortController>())
  const dirtyCallback = useRef(onDirtyChange)
  useEffect(() => { dirtyCallback.current = onDirtyChange }, [onDirtyChange])
  const refreshSequence = sourceUpdate?.path === path ? sourceUpdate.sequence : 0
  const appliedRevision = sourceUpdate?.path === path ? sourceUpdate.revision : undefined
  const appliedDeletion = sourceUpdate?.path === path && sourceUpdate.deleted

  const readLatest = useCallback(async (signal: AbortSignal) => {
    const operation = cloudOperation()
    // Bound the entire read, not only fetch's response headers. An interrupted
    // body reader must settle into Retry instead of leaving the editor loading.
    return readWithDeadline(async (readSignal) => {
      const response = await operation.fetch(endpoint, { signal: readSignal, cache: 'no-store' })
      const revisionHeader = response.headers.get('X-Source-Revision')
      const parsedRevision = sourceRevisionSchema.safeParse(Number(revisionHeader))
      if (response.status === 404) {
        const body = await response.clone().json().catch(() => undefined)
        operation.assertActive(); readSignal.throwIfAborted()
        if (body?.error?.code === 'FILE_DELETED' && revisionHeader && /^\d+$/.test(revisionHeader) && parsedRevision.success && parsedRevision.data !== null) return { content: '', revision: parsedRevision.data, deleted: true }
        if (body?.error?.code === 'FILE_NOT_FOUND' && appliedDeletion && appliedRevision === 0) return { content: '', revision: 0, deleted: true }
      }
      if (!response.ok) throw new Error(await readApiErrorMessage(response, 'Unable to load this file.'))
      if (!revisionHeader || !/^\d+$/.test(revisionHeader) || !parsedRevision.success || parsedRevision.data === null) throw new Error('This file has no valid saved revision. Please reload the application.')
      const content = await response.text()
      operation.assertActive()
      readSignal.throwIfAborted()
      return { content, revision: parsedRevision.data, deleted: false }
    }, AbortSignal.any([signal, operation.signal]), 20_000, 'Loading this file timed out. Your saved source and any open draft are unchanged. Retry loading the file.')
  }, [endpoint, appliedDeletion, appliedRevision])

  useEffect(() => {
    const pending = requests.current
    return () => { for (const request of pending) request.abort(); pending.clear() }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    const pending = requests.current
    pending.add(controller)
    const latest = readLatest(controller.signal)
    void latest.then((file) => {
      if (controller.signal.aborted) return
      if (file.revision < revisionRef.current) return
      if (appliedRevision !== undefined && file.revision < appliedRevision) throw new Error('The saved revision has not refreshed yet. Retry loading this file.')
      if (!dirtyRef.current) { setDraft(file.content); draftRef.current = file.content }
      else setMode('changes')
      setSavedValue(file.content); savedValueRef.current = file.content
      setRevision(file.revision); revisionRef.current = file.revision
      setDeleted(file.deleted); setLoadError(undefined); setConflict(false)
      dirtyRef.current = draftRef.current !== file.content; dirtyCallback.current?.(dirtyRef.current)
    }).catch((error) => {
      if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : 'Unable to load this file.')
    }).finally(() => pending.delete(controller))
    return () => controller.abort()
  }, [readLatest, retry, refreshSequence, appliedRevision, appliedDeletion])

  const dirty = draft !== savedValue

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return
      event.preventDefault()
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [dirty])

  const save = useCallback(async () => {
    if (readOnly || deleted || !dirty || savingRef.current || conflict || revision === undefined) return
    savingRef.current = true
    setSaving(true)
    const submitted = draftRef.current
    const controller = new AbortController()
    requests.current.add(controller)
    try {
      const operation = cloudOperation()
      const result = await awaitMutationReceipt(async signal => {
        const response = await operation.fetch(`/api/sandboxes/${sandboxId}/files`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path, content: submitted, revision }),
          signal,
        })
        if (!response.ok) return { ok: false as const, status: response.status, message: await readApiErrorMessage(response, 'Unable to save this file.') }
        return { ok: true as const, receipt: sourceReceiptSchema.parse(await response.json()) }
      }, AbortSignal.any([controller.signal, operation.signal]), 35_000,
      'The save could not be confirmed within 35 seconds. Your draft is kept. The server may still finish saving; compare the latest version before saving again.')
      operation.assertActive(); controller.signal.throwIfAborted()
      if (!result.ok) {
        if (result.status === 409) setConflict(true)
        throw new Error(result.message)
      }
      const { receipt } = result
      if (receipt.path !== path) throw new Error('The save response referred to a different file.')
      if (receipt.revision < revisionRef.current) {
        setConflict(true)
        throw new Error('A newer revision was loaded while saving. Your draft is kept; compare the latest version before another save.')
      }
      setSavedValue(submitted)
      setSaveUnconfirmed(false)
      savedValueRef.current = submitted
      setRevision(receipt.revision); revisionRef.current = receipt.revision
      // Typing during a save belongs to the next save, not this receipt.
      dirtyRef.current = draftRef.current !== submitted
      dirtyCallback.current?.(dirtyRef.current)
      onSaved?.(path, submitted)
      toast.success(`Saved ${path}`)
    } catch (error) {
      if (!controller.signal.aborted) {
        if (error instanceof MutationReceiptTimeoutError) {
          setSaveUnconfirmed(true)
          setConflict(true)
        }
        toast.error(error instanceof Error ? error.message : 'Unable to save')
      }
    } finally {
      requests.current.delete(controller)
      savingRef.current = false
      if (!controller.signal.aborted) setSaving(false)
    }
  }, [readOnly, deleted, dirty, conflict, revision, onSaved, path, sandboxId])

  const compareLatest = async () => {
    if (comparing || savingRef.current) return
    setComparing(true)
    const controller = new AbortController()
    requests.current.add(controller)
    try {
      const latest = await readLatest(controller.signal)
      setSavedValue(latest.content); savedValueRef.current = latest.content
      setRevision(latest.revision); revisionRef.current = latest.revision
      setDeleted(latest.deleted)
      setMode('changes'); setConflict(false); setSaveUnconfirmed(false)
      dirtyRef.current = draftRef.current !== latest.content
      dirtyCallback.current?.(dirtyRef.current)
    } catch (error) {
      if (!controller.signal.aborted) toast.error(error instanceof Error ? error.message : 'Unable to load latest source')
    } finally {
      requests.current.delete(controller)
      if (!controller.signal.aborted) setComparing(false)
    }
  }

  useEffect(() => { saveRef.current = () => void save() }, [save])

  const handleMount: OnMount = (editor, monaco) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      saveRef.current()
    })
    editor.focus()
  }

  if (loadError && revision === undefined) {
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center"
        role="alert"
      >
        <div>
          <p className="text-sm font-medium text-foreground">File unavailable</p>
          <p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">
            {loadError}
          </p>
        </div>
        <Button
          onClick={() => { setLoadError(undefined); setRetry((value) => value + 1) }}
          size="sm"
          type="button"
          variant="outline"
        >
          Retry
        </Button>
      </div>
    )
  }

  if (revision === undefined) {
    return (
      <div className="flex h-full items-center justify-center">
        <PulseLoader className="opacity-60" size={8} />
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#0d1117]">
      <div className="flex h-9 items-center gap-2 border-b border-white/10 bg-[#161b22] px-3 font-mono text-xs text-zinc-300">
        <span className="truncate">{path}</span>
        <div className="ml-2 flex items-center rounded-md bg-black/20 p-0.5">
          <Button
            className="h-6 gap-1 px-2 text-[10px]"
            onClick={() => setMode('editor')}
            size="sm"
            variant={mode === 'editor' ? 'secondary' : 'ghost'}
          >
            <FileCode2Icon className="size-3" /> Editor
          </Button>
          <Button
            className="h-6 gap-1 px-2 text-[10px]"
            onClick={() => setMode('changes')}
            size="sm"
            variant={mode === 'changes' ? 'secondary' : 'ghost'}
          >
            <Columns2Icon className="size-3" /> Changes
          </Button>
        </div>
        <span className="ml-auto flex items-center gap-1.5 text-[11px]">
          {dirty ? (
            <span className="text-amber-300">Unsaved changes</span>
          ) : (
            <span className="flex items-center gap-1 text-zinc-300">
              <CheckIcon className="size-3" /> Saved
            </span>
          )}
        </span>
        <Button
          aria-label="Revert changes"
          className="h-7 px-2 text-zinc-300 hover:bg-white/10 hover:text-white"
          disabled={readOnly || deleted || !dirty || saving || conflict || comparing}
          onClick={() => {
            setDraft(savedValue)
            draftRef.current = savedValue
            dirtyRef.current = false
            onDirtyChange?.(false)
          }}
          size="sm"
          variant="ghost"
        >
          <RotateCcwIcon className="size-3.5" />
        </Button>
        <Button
          className="h-7 gap-1.5 rounded-md bg-zinc-100 px-2.5 text-xs text-zinc-900 hover:bg-zinc-300"
          disabled={readOnly || deleted || !dirty || saving || conflict || comparing}
          onClick={() => void save()}
          size="sm"
        >
          <SaveIcon className="size-3.5" />
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
      {deleted ? <p role="status" className="border-b border-white/10 p-2 text-xs text-zinc-300">This file was deleted by the reviewed resolution. Any newer editor draft is kept here for copying; recreate the file explicitly if needed.</p> : null}
      {loadError && revision !== undefined ? <div role="alert" className="flex items-center gap-2 border-b border-white/10 p-2 text-xs text-zinc-300"><span>{loadError} Your draft is kept.</span><Button size="sm" variant="outline" onClick={() => setRetry(value => value + 1)}>Retry refresh</Button></div> : null}
      {readOnly ? <p role="status" className="border-b border-white/10 p-2 text-xs text-zinc-300">
        Sandbox expired. Your open draft is still here, read-only. Copy any unsaved changes before restoring a new sandbox.
      </p> : null}
      {conflict && <div className="flex items-center gap-2 border-b border-white/10 p-2 text-xs text-zinc-300" role="alert">
        <span>{saveUnconfirmed
          ? 'The save could not be confirmed. Your draft is kept; the server may still finish saving. Compare the latest version before saving again.'
          : 'This file changed elsewhere. Your draft is kept. Compare the latest version before saving.'}</span>
        <Button size="sm" variant="outline" disabled={comparing} onClick={() => void compareLatest()}>{comparing ? 'Loading latest…' : 'Compare latest'}</Button>
      </div>}
      <div className="min-h-0 flex-1">
        {mode === 'editor' ? (
          <MonacoEditor
            height="100%"
            language={detectLanguage(path)}
            onChange={(value) => {
              const next = value ?? ''
              setDraft(next)
              draftRef.current = next
              const nextDirty = next !== savedValueRef.current
              dirtyRef.current = nextDirty
              onDirtyChange?.(nextDirty)
            }}
            onMount={handleMount}
            options={{ ...editorOptions, readOnly: readOnly || deleted }}
            theme="vs-dark"
            value={draft}
          />
        ) : (
          <MonacoDiffEditor
            height="100%"
            language={detectLanguage(path)}
            modified={draft}
            options={{ ...editorOptions, readOnly: true, renderSideBySide: true }}
            original={savedValue}
            theme="vs-dark"
          />
        )}
      </div>
    </div>
  )
}

const editorOptions = {
  automaticLayout: true,
  fontFamily: 'var(--font-geist-mono), Geist Mono, monospace',
  fontLigatures: true,
  fontSize: 13,
  minimap: { enabled: false },
  padding: { top: 14 },
  renderLineHighlight: 'gutter' as const,
  scrollBeyondLastLine: false,
  tabSize: 2,
  wordWrap: 'on' as const,
}

function detectLanguage(path: string) {
  const extension = path.split('.').pop()?.toLowerCase()
  const languages: Record<string, string> = {
    c: 'c',
    cpp: 'cpp',
    css: 'css',
    go: 'go',
    html: 'html',
    java: 'java',
    js: 'javascript',
    json: 'json',
    jsx: 'javascript',
    md: 'markdown',
    py: 'python',
    rs: 'rust',
    sh: 'shell',
    sql: 'sql',
    ts: 'typescript',
    tsx: 'typescript',
    yaml: 'yaml',
    yml: 'yaml',
  }
  return languages[extension ?? ''] ?? 'plaintext'
}
