import { apiFailure, apiJson } from '@/lib/server/api'
import { runSandboxCleanupBatch } from '@/lib/server/sandbox-cleanup-worker'
import { observeWorker, requireWorkerAuthorization } from '@/lib/server/worker-health'

export const maxDuration = 60
export async function GET(request: Request) {
  const requestId = crypto.randomUUID()
  try {
    requireWorkerAuthorization(request, 'CLEANUP_WORKER_UNCONFIGURED', 'Sandbox cleanup scheduling is not configured.')
    const result = await observeWorker('sandbox-cleanup', requestId, () => runSandboxCleanupBatch(), result => result.failed === 0)
    if (result.failed) console.warn('Sandbox cleanup batch needs retry', { requestId, ...result })
    return apiJson(result, requestId, result.failed ? 503 : 200)
  } catch (error) { return apiFailure(error, requestId) }
}
