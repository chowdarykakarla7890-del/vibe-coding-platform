import { timingSafeEqual } from 'node:crypto'
import { ApiError, apiFailure, apiJson } from '@/lib/server/api'
import { runSourceCaptureBatch } from '@/lib/server/source-capture-worker'

export const maxDuration = 60

export async function GET(request: Request) {
  const requestId = crypto.randomUUID()
  try {
    const secret = process.env.CRON_SECRET
    if (!secret || secret.length < 32) throw new ApiError(503, 'CAPTURE_WORKER_UNCONFIGURED', 'Source recovery scheduling is not configured.')
    const provided = Buffer.from(request.headers.get('authorization') ?? '')
    const expected = Buffer.from(`Bearer ${secret}`)
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw new ApiError(401, 'WORKER_AUTH_REQUIRED', 'Worker authorization is required.')
    }
    const result = await runSourceCaptureBatch()
    if (result.failed) console.warn('Source capture batch needs retry', { requestId, ...result })
    return apiJson(result, requestId, result.failed ? 503 : 200)
  } catch (error) { return apiFailure(error, requestId) }
}
