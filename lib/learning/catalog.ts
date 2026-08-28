import type { ActivityManifest, ActivityMode } from './types'
import { TRUSTED_DSA_IDS, trustedDSAActivity } from './dsa'
import { PRACTICE_ACTIVITIES } from './practice'
import { DEBUG_ACTIVITIES } from './debug'
import { CHALLENGE_ACTIVITIES } from './challenges'
import { PROJECT_ACTIVITIES } from './blueprints'
export { PROJECT_ACTIVITIES } from './blueprints'
export { PRACTICE_ACTIVITIES } from './practice'
export { DEBUG_ACTIVITIES } from './debug'
export { CHALLENGE_ACTIVITIES } from './challenges'

export const DSA_ACTIVITIES = TRUSTED_DSA_IDS.map(trustedDSAActivity)

export const CURATED_ACTIVITIES = [
  ...PRACTICE_ACTIVITIES,
  ...DEBUG_ACTIVITIES,
  ...CHALLENGE_ACTIVITIES,
  ...PROJECT_ACTIVITIES,
  ...DSA_ACTIVITIES,
]

export const activitiesByMode: Record<ActivityMode, ActivityManifest[]> = {
  practice: PRACTICE_ACTIVITIES,
  debug: DEBUG_ACTIVITIES,
  challenge: CHALLENGE_ACTIVITIES,
  project: PROJECT_ACTIVITIES,
  dsa: DSA_ACTIVITIES,
}

export function getActivity(id: string) {
  return CURATED_ACTIVITIES.find((activity) => activity.id === id)
}
