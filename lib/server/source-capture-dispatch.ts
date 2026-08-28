import 'server-only'
import { after } from 'next/server'
import { processSourceCapture } from './source-capture-worker'
import { createAdminSupabaseClient } from '@/lib/supabase/server'
import { abortableRead } from '@/lib/abortable-read'
import { setTimeout as pause } from 'node:timers/promises'
import { z } from 'zod'

const pendingJob = z.object({ state: z.string(), available_at: z.string().datetime({ offset: true }), lease_until: z.string().datetime({ offset: true }).nullable() })

/** Opportunistic low-latency delivery. The database job and scheduled worker
 * remain authoritative when the request process dies or the browser closes. */
export function scheduleSourceCapture(jobId: string) {
  after(async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 45_000)
    try {
      // One immediate claim can lose to an earlier capture for this account.
      // Retry only this still-pending job, with bounded backoff. Do not rescan
      // finished jobs on every log/status request or wait on distant leases.
      for (let attempt = 0; attempt < 8; attempt++) {
        const outcome = await abortableRead(() => processSourceCapture(jobId, controller.signal), controller.signal)
        if (outcome !== 'idle' || controller.signal.aborted || attempt === 7) return
        const result = await abortableRead(async () => await createAdminSupabaseClient().from('source_capture_jobs')
          .select('state,available_at,lease_until').eq('id', jobId).abortSignal(controller.signal).maybeSingle(), controller.signal)
        if (result.error) throw new Error('Capture dispatch status unavailable.')
        if (!result.data) return
        const job = pendingJob.parse(result.data)
        if (!['queued', 'capturing', 'acknowledging'].includes(job.state)) return
        const due = Math.max(Date.parse(job.available_at), job.lease_until ? Date.parse(job.lease_until) : 0)
        if (due > Date.now() + 4000) return // Durable scheduler owns later work.
        if (attempt === 0) console.info('Source capture dispatch deferred', { jobId, state: job.state })
        await pause(Math.max(Math.min(attempt + 1, 4) * 1000, due - Date.now()), undefined, { signal: controller.signal })
      }
    }
    catch { console.warn('Source capture needs scheduled retry', { jobId }) }
    finally { clearTimeout(timer); controller.abort() }
  })
}
