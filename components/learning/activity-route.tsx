import { ActivityWorkspace } from './activity-workspace'
import { isActivityRouteValid } from '@/lib/learning/activity-route'
import type { ActivityMode } from '@/lib/learning/types'
import { notFound } from 'next/navigation'

export function ActivityRoute({
  activityId,
  mode,
}: {
  activityId: string
  mode: ActivityMode
}) {
  if (!isActivityRouteValid(activityId, mode)) notFound()
  return <ActivityWorkspace activityId={activityId} key={activityId} mode={mode} />
}
