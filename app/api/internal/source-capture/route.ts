import { apiFailure, apiJson } from '@/lib/server/api'
import { runSourceCaptureBatch } from '@/lib/server/source-capture-worker'
import { observeWorker, requireWorkerAuthorization } from '@/lib/server/worker-health'

export const maxDuration = 60

export async function GET(request: Request) {
  const requestId = crypto.randomUUID()
  try {
    requireWorkerAuthorization(request, 'CAPTURE_WORKER_UNCONFIGURED', 'Source recovery scheduling is not configured.')
    const result = await observeWorker('source-capture', requestId, () => runSourceCaptureBatch(), result => result.failed === 0)
    if (result.failed) console.warn('Source capture batch needs retry', { requestId, ...result })
    return apiJson(result, requestId, result.failed ? 503 : 200)
  } catch (error) { return apiFailure(error, requestId) }
}
