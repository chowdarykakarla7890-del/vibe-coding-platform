import { apiFailure, apiJson } from '@/lib/server/api'
import { readWorkerHealth, requireWorkerAuthorization } from '@/lib/server/worker-health'

export const maxDuration = 10

export async function GET(request: Request) {
  const requestId = crypto.randomUUID()
  try {
    requireWorkerAuthorization(request, 'WORKER_HEALTH_UNCONFIGURED', 'Worker health monitoring is not configured.')
    const result = await readWorkerHealth(request.signal)
    return apiJson(result, requestId, result.status === 'healthy' ? 200 : 503)
  } catch (error) { return apiFailure(error, requestId) }
}
