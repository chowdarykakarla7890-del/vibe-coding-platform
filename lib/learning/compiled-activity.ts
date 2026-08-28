import { PRACTICE_ACTIVITIES } from './practice'
import { DEBUG_ACTIVITIES } from './debug'
import { PROJECT_ACTIVITIES } from './blueprints'

/** Eligibility comes from the curated registry and persisted project language,
 * never a generated manifest's setup command or a language name alone. */
export function curatedCompiler(activityId: string | null, language: string) {
  const activity = [...PRACTICE_ACTIVITIES, ...DEBUG_ACTIVITIES, ...PROJECT_ACTIVITIES].find(item => item.id === activityId)
  return activity?.language === language && (language === 'Java' || language === 'C++') ? language : undefined
}
