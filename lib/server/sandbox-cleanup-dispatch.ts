import 'server-only'
import { after } from 'next/server'
import { runSandboxCleanupBatch } from './sandbox-cleanup-worker'

/** Opportunistic delivery only. The database job and cron own crash recovery. */
export function scheduleSandboxCleanup(jobIds: string[]) {
  if (!jobIds.length) return
  try {
    after(async () => {
      try {
        const result = await runSandboxCleanupBatch(jobIds)
        if (result.failed) console.warn('Sandbox cleanup needs scheduled retry', result)
      } catch { console.warn('Sandbox cleanup dispatch unavailable') }
    })
  } catch {
    // Library-only callers may not have a Next request context. The durable
    // scheduler must still own these records; never undo the deletion.
    console.warn('Sandbox cleanup deferred to scheduler')
  }
}
