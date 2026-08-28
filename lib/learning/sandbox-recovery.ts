import { getApiErrorMessage } from '@/lib/api-error'
import { restorableSourceFileSchema } from '@/lib/source-version'
import { hasSnapshotPathConflict, MAX_PROJECT_FILES, MAX_PROJECT_SNAPSHOT_BYTES, sourceByteLength } from './snapshots'
import { z } from 'zod'
import { abortableRead, readWithDeadline } from '@/lib/abortable-read'
import { cloudOperation } from './cloud-request'
import { sandboxLifecycleSchema } from '@/lib/sandbox/lifecycle'
import { awaitMutationReceipt } from '@/lib/mutation-receipt'

const sandboxResponseSchema = z.object({ sandboxId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/) })
const snapshotSchema = z.array(restorableSourceFileSchema).max(MAX_PROJECT_FILES)
  .refine((files) => new Set(files.map((file) => file.path)).size === files.length)
  .refine((files) => !hasSnapshotPathConflict(files.map((file) => file.path)))
  .refine((files) => files.reduce((total, file) => total + sourceByteLength(file.content), 0) <= MAX_PROJECT_SNAPSHOT_BYTES)

// Stay below the hosting request-body limit, including JSON escape overhead.
export const MAX_RESTORE_REQUEST_BYTES = 2 * 1024 * 1024

/** All source uploads succeeded, but the client could not reopen the project. */
export class SandboxReopenRequiredError extends Error {
  override name = 'SandboxReopenRequiredError'

  constructor() {
    super('Your files were restored, but reopening the project could not be confirmed. The replacement has not been stopped. Reopen the project to check its saved state before creating another sandbox.')
  }
}

function restoreBatches(files: z.infer<typeof restorableSourceFileSchema>[]) {
  const batches: typeof files[] = []
  let batch: typeof files = []
  let bytes = sourceByteLength('{"files":[]}')
  for (const file of files) {
    const fileBytes = sourceByteLength(JSON.stringify(file))
    if (batch.length && bytes + 1 + fileBytes > MAX_RESTORE_REQUEST_BYTES) {
      batches.push(batch)
      batch = []
      bytes = sourceByteLength('{"files":[]}')
    }
    bytes += fileBytes + (batch.length ? 1 : 0)
    batch.push(file)
  }
  if (batch.length) batches.push(batch)
  return batches
}

export async function readSandboxStatus(sandboxId: string, signal: AbortSignal) {
  const lifecycle = await readSandboxLifecycle(sandboxId, signal)
  return lifecycle.status === 'ok' ? 'running' as const : lifecycle.status
}

export async function readSandboxLifecycle(sandboxId: string, signal: AbortSignal) {
  // Bound the complete read, including body consumption. Merely passing a
  // signal to fetch cannot settle a reader that fails to observe cancellation.
  return readWithDeadline(async (requestSignal) => {
    const operation = cloudOperation(requestSignal)
    const response = await operation.fetch(`/api/sandboxes/${encodeURIComponent(sandboxId)}`, {
      signal: requestSignal,
      cache: 'no-store',
    })
    // Expiration is a normal lifecycle event, not an application-load failure.
    // The account/caller guard in operation.fetch also applies to this branch.
    if (response.status === 410) return { status: 'stopped' as const }
    const body: unknown = await response.json().catch(() => undefined)
    operation.assertActive()
    if (!response.ok) {
      throw new Error(getApiErrorMessage(body, 'The sandbox status could not be checked. Try again.'))
    }
    const parsed = sandboxLifecycleSchema.safeParse(body)
    if (!parsed.success) throw new Error('The sandbox returned an invalid status. Try again.')
    return parsed.data
  }, signal, 10_000, 'The sandbox status check timed out. Try again.')
}

export async function requestSandboxShutdown(sandboxId: string, signal: AbortSignal) {
  return cloudOperation(signal).request(`/api/sandboxes/${encodeURIComponent(sandboxId)}`, sandboxLifecycleSchema, 'DELETE')
}

interface RestoreOptions {
  projectId: string
  signal: AbortSignal
  loadFiles: (signal: AbortSignal) => Promise<unknown>
  commit: (sandboxId: string) => Promise<void>
  /** Cancellation can no longer undo the association once this write starts. */
  onCommitting?: () => void
  /** Persist validated activity settings before the server prepares its VM. */
  beforeCreate?: (signal: AbortSignal) => Promise<void>
  timeoutMs?: number
}

/** Only attach a replacement after every source file has been acknowledged. */
export function restoreProjectSandbox(options: RestoreOptions) {
  return provisionProjectSandbox(options, false)
}

/** Manual startup needs no model. Restore existing source before opening it. */
export function startProjectSandbox(options: RestoreOptions) {
  return provisionProjectSandbox(options, true)
}

async function provisionProjectSandbox({ projectId, signal: callerSignal, loadFiles, commit, onCommitting, beforeCreate, timeoutMs = 60_000 }: RestoreOptions, allowEmpty: boolean) {
  const operation = cloudOperation()
  const deadline = AbortSignal.timeout(timeoutMs)
  const signal = AbortSignal.any([callerSignal, deadline, operation.signal])
  let replacementId: string | undefined
  let committed = false
  let sourceRestored = false
  const cleanupRequests = new Map<string, Promise<void>>()
  function cleanupReplacement(id: string) {
    const pending = cleanupRequests.get(id)
    if (pending) return pending
    // Capture the originating account and never reuse the cancelled restore
    // signal. A late creation receipt and finally may request the same cleanup.
    // Bound the wait independently of fetch observing cancellation. This is
    // best-effort shutdown, not a rollback: the server may still finish the
    // request after the UI settles. Never claim the replacement was stopped
    // or retry its creation automatically when the receipt is unknown.
    const request = new Promise<void>((resolve) => {
      const controller = new AbortController()
      let settled = false
      const finish = (acknowledged: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (!acknowledged) {
          console.warn('Sandbox replacement shutdown request unconfirmed', { sandboxId: id })
        }
        resolve()
      }
      const timer = setTimeout(() => {
        controller.abort()
        finish(false)
      }, 5_000)
      void operation.fetch(`/api/sandboxes/${id}`, {
        method: 'DELETE',
        signal: controller.signal,
      }).then(
        (response) => finish(response.ok || response.status === 410),
        () => finish(false),
      )
    })
    cleanupRequests.set(id, request)
    return request
  }
  try {
    const stored = await abortableRead(() => loadFiles(signal), signal)
    signal.throwIfAborted()
    if (!allowEmpty && Array.isArray(stored) && stored.length === 0) {
      throw new Error('No source snapshot is saved for this project. Your chat and learning history are unchanged. Close this dialog to choose another project.')
    }
    const parsed = snapshotSchema.safeParse(stored)
    if (!parsed.success) {
      throw new Error('The saved source snapshot could not be validated. It has not been changed. Export the project before trying to repair it.')
    }
    const files = parsed.data
    if (beforeCreate) {
      // Cancellation stops waiting, not a rollback of settings already saved.
      // Do not provision until that acknowledgment and account guard succeed.
      await abortableRead(() => beforeCreate(signal), signal)
      signal.throwIfAborted()
      operation.assertActive()
    }
    const creationReceipt = operation.fetch('/api/sandboxes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, ports: [3000] }),
      signal,
    }).then(async created => ({ created, body: await created.json().catch(() => undefined) as unknown }))
    // Stop waiting for an unresponsive reader on cancellation, but still
    // observe a late receipt so an acknowledged replacement is not abandoned.
    void creationReceipt.then(async ({ created, body }) => {
      if (!signal.aborted || !created.ok || committed) return
      const late = sandboxResponseSchema.safeParse(body)
      if (late.success) await cleanupReplacement(late.data.sandboxId)
    }).catch(() => undefined)
    const { created, body } = await abortableRead(() => creationReceipt, signal)
    if (!created.ok) throw new Error(getApiErrorMessage(body, 'Could not create a replacement sandbox.'))
    const sandbox = sandboxResponseSchema.safeParse(body)
    if (!sandbox.success) throw new Error('The replacement sandbox response was invalid.')
    replacementId = sandbox.data.sandboxId
    signal.throwIfAborted()
    for (const batch of restoreBatches(files)) {
      signal.throwIfAborted()
      const uploadReceipt = operation.fetch(`/api/sandboxes/${replacementId}/snapshot`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ files: batch }),
        signal,
      }).then(async restored => ({ restored, result: await restored.json().catch(() => undefined) as unknown }))
      // The transport may synchronously abort before the receipt waiter is
      // attached. Observe its rejection even in that cancellation race.
      void uploadReceipt.catch(() => undefined)
      // The request's signal alone does not guarantee that a body reader
      // settles. Bound the read too; never race the final association write.
      const { restored, result } = await abortableRead(() => uploadReceipt, signal)
      if (!restored.ok) throw new Error(getApiErrorMessage(result, 'Files could not be restored. Your saved snapshot is unchanged.'))
      const receipt = z.object({ restored: z.number().int().nonnegative() }).safeParse(result)
      if (!receipt.success || receipt.data.restored !== batch.length) {
        throw new Error('The sandbox did not confirm all saved files were restored. Please retry.')
      }
    }
    signal.throwIfAborted()
    sourceRestored = true
    onCommitting?.()
    // The association may queue behind another project save. A completed
    // upload must not leave the non-cancellable "Saving workspace" phase
    // waiting forever. Bound confirmation independently of the earlier
    // provisioning deadline and navigation: a save that already started may
    // still succeed. Missing confirmation requires reopening, never another
    // automatic restore or destruction of the acknowledged source.
    const restoredSandboxId = replacementId
    await awaitMutationReceipt(
      () => commit(restoredSandboxId),
      operation.signal,
      20_000,
      'The restored workspace save could not be confirmed. Reopen the project to check its saved state.',
    )
    committed = true
    return { sandboxId: replacementId, files }
  } catch (error) {
    // Creation already registers the owned replacement on the server. After
    // every upload is acknowledged, a failed project refresh/save is not a
    // rollback. Stopping that VM here strands a successfully restored project.
    if (sourceRestored) throw new SandboxReopenRequiredError()
    if (deadline.aborted && !callerSignal.aborted && !operation.signal.aborted) {
      throw new Error('Restoring the sandbox timed out. Your saved snapshot is unchanged. Please retry.')
    }
    throw error
  } finally {
    if (replacementId && !sourceRestored && !committed) {
      await cleanupReplacement(replacementId)
    }
  }
}
