import { getActivity } from './catalog'
import type { ActivityMode } from './types'

export function isActivityRouteValid(activityId: string, mode: ActivityMode) {
  const curated = getActivity(activityId)
  if (curated) return curated.mode === mode
  return activityId.startsWith(`generated-${mode}-`)
}
