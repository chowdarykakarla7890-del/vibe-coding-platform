import { apiFailure, apiJson, requireUser } from '@/lib/server/api'
import { findOwnedActivity } from '@/lib/server/activities'

export async function GET(request: Request, { params }: { params: Promise<{ activityId: string }> }) {
  const requestId = crypto.randomUUID()
  try {
    const auth = await requireUser(request)
    const { activityId } = await params
    return apiJson({ activity: await findOwnedActivity(auth, activityId) ?? null }, requestId)
  } catch (error) { return apiFailure(error, requestId) }
}
