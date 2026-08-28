'use client'

import {
  ChevronRightIcon,
  ChevronDownIcon,
  FolderIcon,
  FolderPlusIcon,
  FileIcon,
  FilePlus2Icon,
  Code2Icon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { FileContent } from '@/components/file-explorer/file-content'
import { Panel, PanelHeader } from '@/components/panels/panels'
import { ScrollArea } from '@/components/ui/scroll-area'
import { buildFileTree, type FileNode } from './build-file-tree'
import { useState, useMemo, useCallback, memo, useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { getApiErrorMessage } from '@/lib/api-error'
import { cloudOperation } from '@/lib/learning/cloud-request'
import { awaitMutationReceipt } from '@/lib/mutation-receipt'
import { SandboxReopenRequiredError } from '@/lib/learning/sandbox-recovery'

interface Props {
  className: string
  disabled?: boolean
  paths: string[]
  sandboxId?: string
  initialSelectedPath?: string
  sourceUpdate?: { path: string; revision: number; deleted: boolean; sequence: number }
  onSaved?: (path: string, content: string) => void
  onPathsCreated?: (paths: string[]) => void
  onSelectedPathChange?: (path: string) => void
  onDirtyPathChange?: (path?: string) => void
  onStartWorkspace?: (signal: AbortSignal) => Promise<void>
}

export const FileExplorer = memo(function FileExplorer({
  className,
  disabled,
  paths,
  sandboxId,
  initialSelectedPath,
  sourceUpdate,
  onSaved,
  onPathsCreated,
  onSelectedPathChange,
  onDirtyPathChange,
  onStartWorkspace,
}: Props) {
  const fileTree = useMemo(() => buildFileTree(paths), [paths])
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    () => new Set(initialSelectedPath?.split('/').slice(0, -1).map((_, index, parts) => `/${parts.slice(0, index + 1).join('/')}`) ?? [])
  )
  const [selectedPath, setSelectedPath] = useState<string | null>(initialSelectedPath ?? null)
  const [dirtyPath, setDirtyPath] = useState<string | null>(null)
  const previousSandboxId = useRef(sandboxId)

  useEffect(() => {
    if (previousSandboxId.current === sandboxId) return
    previousSandboxId.current = sandboxId
    setExpandedFolders(new Set())
    setSelectedPath(null)
    setDirtyPath(null)
    onDirtyPathChange?.(undefined)
  }, [onDirtyPathChange, sandboxId])
  const firstFilePath = useMemo(() => {
    const files = new Set<string>()
    const pending = [...fileTree]
    while (pending.length) {
      const node = pending.pop()!
      if (node.type === 'file') files.add(node.path)
      else if (node.children) pending.push(...node.children)
    }
    // Preserve the incoming order, but don't open an old file entry that the
    // recovered tree now identifies as a directory.
    return paths.find((path) => files.has(path.startsWith('/') ? path : `/${path}`)) ?? null
  }, [fileTree, paths])
  // A reviewed deletion may remove the auto-selected path while the learner
  // types. Keep that mounted draft instead of jumping to the next file.
  const currentPath = selectedPath ?? dirtyPath ?? firstFilePath
  const selected = useMemo(
    () =>
      currentPath
        ? {
            name: currentPath.split('/').filter(Boolean).pop() ?? currentPath,
            path: currentPath.startsWith('/') ? currentPath : `/${currentPath}`,
            type: 'file' as const,
          }
        : null,
    [currentPath]
  )
  const fs = useMemo(
    () => applyExpandedFolders(fileTree, expandedFolders),
    [expandedFolders, fileTree]
  )

  const toggleFolder = useCallback((path: string) => {
    setExpandedFolders((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const selectFile = useCallback((node: FileNode) => {
    if (node.type === 'file') {
      const nextPath = node.path.replace(/^\//, '')
      if (node.path === selected?.path) {
        // Reselecting the current editor must not clear its dirty guard.
        onSelectedPathChange?.(nextPath)
        return
      }
      if (dirtyPath && dirtyPath !== nextPath && !window.confirm(`Discard unsaved changes in ${dirtyPath}?`)) return
      setDirtyPath(null)
      onDirtyPathChange?.(undefined)
      setSelectedPath(nextPath)
      onSelectedPathChange?.(nextPath)
    }
  }, [dirtyPath, onDirtyPathChange, onSelectedPathChange, selected?.path])

  const handleCreated = useCallback(
    (path: string, type: 'file' | 'folder') => {
      onPathsCreated?.([path])
      if (type === 'file') {
        // Creating a file must respect the same draft guard as selecting one.
        selectFile({ name: path.split('/').pop() ?? path, path: `/${path}`, type: 'file' })
      }
    },
    [onPathsCreated, selectFile]
  )

  const renderFileTree = useCallback(
    (nodes: FileNode[], depth = 0) => {
      return nodes.map((node) => (
        <FileTreeNode
          key={node.path}
          node={node}
          depth={depth}
          selected={selected}
          onToggleFolder={toggleFolder}
          onSelectFile={selectFile}
          renderFileTree={renderFileTree}
        />
      ))
    },
    [selected, toggleFolder, selectFile]
  )

  return (
    <Panel className={cn('overflow-hidden bg-background', className)}>
      <PanelHeader>
        <Code2Icon className="w-4 mr-2 text-zinc-400" />
        <span className="font-mono uppercase font-semibold">
          Student editor
        </span>
        {selected && (
          <span className="ml-auto text-gray-500">{selected.path}</span>
        )}
        <CreateNodeControl
          key={`${sandboxId ?? 'empty'}:${disabled ? 'readonly' : 'editable'}`}
          disabled={disabled}
          onCreated={handleCreated}
          onStartWorkspace={onStartWorkspace}
          sandboxId={sandboxId}
        />
      </PanelHeader>

      <div className="flex min-h-0 flex-1 text-sm">
        <ScrollArea className="w-48 shrink-0 border-r border-border bg-secondary/40">
          <div className="py-2">{renderFileTree(fs)}</div>
        </ScrollArea>
        {selected && sandboxId && (
          <div className="min-w-0 flex-1">
            <FileContent
              sourceUpdate={sourceUpdate}
              sandboxId={sandboxId}
              path={selected.path.substring(1)}
              readOnly={disabled}
              onSaved={onSaved}
              onDirtyChange={(dirty) => {
                const nextDirtyPath = dirty
                  ? selected.path.substring(1)
                  : undefined
                setDirtyPath(nextDirtyPath ?? null)
                onDirtyPathChange?.(nextDirtyPath)
              }}
            />
          </div>
        )}
        {(!selected || !sandboxId) && (
          <div className="flex flex-1 items-center justify-center p-8 text-center font-mono text-xs text-muted-foreground">
            {sandboxId
              ? disabled ? 'This sandbox expired. Saved files remain available; restore the sandbox to continue coding.' : 'Choose a file to start editing.'
              : 'Tell your tutor what you want to learn. Your editable project will appear here.'}
          </div>
        )}
      </div>
    </Panel>
  )
})

function applyExpandedFolders(
  nodes: FileNode[],
  expandedFolders: Set<string>
): FileNode[] {
  return nodes.map((node) => ({
    ...node,
    expanded: node.type === 'folder' && expandedFolders.has(node.path),
    children: node.children
      ? applyExpandedFolders(node.children, expandedFolders)
      : undefined,
  }))
}

function CreateNodeControl({
  disabled,
  onCreated,
  sandboxId,
  onStartWorkspace,
}: {
  disabled?: boolean
  onCreated: (path: string, type: 'file' | 'folder') => void
  sandboxId?: string
  onStartWorkspace?: (signal: AbortSignal) => Promise<void>
}) {
  const [kind, setKind] = useState<'file' | 'folder'>('file')
  const [open, setOpen] = useState(false)
  const [path, setPath] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reopenRequired, setReopenRequired] = useState(false)
  const request = useRef<AbortController | null>(null)
  const createdCallback = useRef(onCreated)
  useEffect(() => { createdCallback.current = onCreated }, [onCreated])
  useEffect(() => () => { request.current?.abort() }, [])

  const createNode = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (disabled || request.current) return
    const normalizedPath = path.trim().replace(/^\/+|\/+$/g, '')
    if (!sandboxId || !normalizedPath || normalizedPath.split('/').includes('..')) {
      setError('Enter a valid relative path.')
      return
    }

    setSubmitting(true)
    setError(null)
    const controller = new AbortController()
    request.current = controller
    try {
      const operation = cloudOperation(controller.signal)
      const { response, data } = await awaitMutationReceipt(async signal => {
        const response = await operation.fetch(`/api/sandboxes/${sandboxId}/files`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: normalizedPath, type: kind }),
          signal,
        })
        return { response, data: await response.json().catch(() => undefined) as unknown }
      }, operation.signal, 35_000,
      'Creation could not be confirmed within 35 seconds. The server may still create the item. Check the file tree before retrying; no existing source has been overwritten.')
      operation.assertActive()
      if (!response.ok) {
        throw new Error(getApiErrorMessage(data, 'Unable to create item'))
      }
      if (
        !data ||
        typeof data !== 'object' ||
        typeof (data as { path?: unknown }).path !== 'string' ||
        ((data as { type?: unknown }).type !== 'file' &&
          (data as { type?: unknown }).type !== 'folder')
      ) {
        throw new Error('The server returned an invalid file response.')
      }
      const created = data as { path: string; type: 'file' | 'folder' }
      createdCallback.current(created.path, created.type)
      setPath('')
      setOpen(false)
    } catch (caughtError) {
      if (!controller.signal.aborted) setError(caughtError instanceof Error ? caughtError.message : 'Unable to create item')
    } finally {
      if (request.current === controller) request.current = null
      if (!controller.signal.aborted) setSubmitting(false)
    }
  }

  const createWorkspace = async () => {
    if (disabled || request.current || reopenRequired || !onStartWorkspace) return
    const controller = new AbortController()
    request.current = controller
    setSubmitting(true)
    setError(null)
    try {
      await onStartWorkspace(controller.signal)
      if (!controller.signal.aborted) setOpen(false)
    } catch (caughtError) {
      if (!controller.signal.aborted) {
        setReopenRequired(caughtError instanceof SandboxReopenRequiredError)
        setError(caughtError instanceof Error ? caughtError.message : 'Unable to start workspace. Your saved work has not been cleared.')
      }
    } finally {
      if (request.current === controller) request.current = null
      if (!controller.signal.aborted) setSubmitting(false)
    }
  }

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button
          aria-label="Create file or folder"
          className="size-7 rounded-md border-border bg-secondary/50 text-zinc-300 hover:bg-secondary hover:text-foreground"
          disabled={disabled}
          size="icon"
          variant="outline"
        >
          <FilePlus2Icon className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 border-border bg-popover p-3">
        {!sandboxId ? (
          <div className="space-y-3">
            <div>
              <div className="text-xs font-medium text-foreground">Start a workspace</div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Files and folders are stored in a sandbox. Create a blank workspace first,
                then add anything you need. Existing saved files will be restored; no AI request is needed.
              </p>
            </div>
            {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
            {reopenRequired ? <Button className="w-full" onClick={() => window.location.reload()} type="button">Reopen project</Button>
              : <Button className="w-full" disabled={submitting || !onStartWorkspace} onClick={() => void createWorkspace()} type="button">
                {submitting ? 'Starting workspace…' : 'Create blank workspace'}
              </Button>}
            {submitting ? <p role="status" className="text-xs text-muted-foreground">Preparing your sandbox and checking saved source…</p> : null}
          </div>
        ) : (
          <>
            <div className="mb-3 text-xs font-medium text-foreground">Add to project</div>
            <div className="mb-3 grid grid-cols-2 gap-1 rounded-md bg-secondary p-1">
              <Button
                className="h-7 gap-1.5 text-xs"
                onClick={() => setKind('file')}
                size="sm"
                type="button"
                variant={kind === 'file' ? 'default' : 'ghost'}
              >
                <FilePlus2Icon className="size-3.5" /> File
              </Button>
              <Button
                className="h-7 gap-1.5 text-xs"
                onClick={() => setKind('folder')}
                size="sm"
                type="button"
                variant={kind === 'folder' ? 'default' : 'ghost'}
              >
                <FolderPlusIcon className="size-3.5" /> Folder
              </Button>
            </div>
            <form className="space-y-2" onSubmit={(event) => void createNode(event)}>
              <Input
                aria-label={kind === 'file' ? 'New file path' : 'New folder path'}
                autoFocus
                onChange={(event) => setPath(event.target.value)}
                placeholder={kind === 'file' ? 'src/components/card.tsx' : 'src/components'}
                value={path}
              />
              {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
              <Button className="w-full" disabled={submitting || !path.trim()} type="submit">
                {submitting ? 'Creating…' : `Create ${kind}`}
              </Button>
            </form>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}

// Memoized file tree node component
const FileTreeNode = memo(function FileTreeNode({
  node,
  depth,
  selected,
  onToggleFolder,
  onSelectFile,
  renderFileTree,
}: {
  node: FileNode
  depth: number
  selected: FileNode | null
  onToggleFolder: (path: string) => void
  onSelectFile: (node: FileNode) => void
  renderFileTree: (nodes: FileNode[], depth: number) => React.ReactNode
}) {
  const handleClick = useCallback(() => {
    if (node.type === 'folder') {
      onToggleFolder(node.path)
    } else {
      onSelectFile(node)
    }
  }, [node, onToggleFolder, onSelectFile])

  return (
    <div>
      <button
        aria-expanded={node.type === 'folder' ? node.expanded : undefined}
        aria-label={`${node.type === 'folder' ? 'Folder' : 'File'} ${node.name}`}
        className={cn(
          'flex w-full cursor-pointer items-center px-1 py-1 text-left text-xs hover:bg-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-zinc-500',
          { 'bg-secondary text-foreground': selected?.path === node.path }
        )}
        onClick={handleClick}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        type="button"
      >
        {node.type === 'folder' ? (
          <>
            {node.expanded ? (
              <ChevronDownIcon className="w-4 mr-1" />
            ) : (
              <ChevronRightIcon className="w-4 mr-1" />
            )}
            <FolderIcon className="w-4 mr-2" />
          </>
        ) : (
          <>
            <div className="w-4 mr-1" />
            <FileIcon className="w-4 mr-2 " />
          </>
        )}
        <span>{node.name}</span>
      </button>

      {node.type === 'folder' && node.expanded && node.children && (
        <div>{renderFileTree(node.children, depth + 1)}</div>
      )}
    </div>
  )
})
