import 'server-only'
import { getActivity } from '@/lib/learning/catalog'
import { activityManifestSchema, type ActivityManifest, type VerificationResult } from '@/lib/learning/types'
import { isSafeCommand } from '@/lib/learning/scoring'
import { createAdminSupabaseClient } from '@/lib/supabase/server'
import type { Json } from '@/lib/supabase/database.types'
import { ApiError, type AuthContext } from './api'

export async function findOwnedActivity(auth: AuthContext, id: string) {
  if (!/^[a-z0-9][a-z0-9-]{2,79}$/.test(id)) throw new ApiError(400, 'INVALID_ACTIVITY_ID', 'Choose a valid activity.')
  const curated = getActivity(id)
  if (curated) return curated
  const { data, error } = await auth.supabase.from('generated_activities').select('manifest').eq('user_id', auth.user.id).eq('id', id).maybeSingle()
  if (error) throw error
  if (!data) return undefined
  const activity = activityManifestSchema.parse(data.manifest)
  if (activity.id !== id || activity.source !== 'generated') throw new Error('Stored activity identity is invalid.')
  return activity
}

export function validateGeneratedActivity(input: unknown): ActivityManifest {
  const activity = activityManifestSchema.parse(input)
  if (activity.source !== 'generated' || !activity.id.startsWith('generated-')) throw new Error('Invalid generated activity identity.')
  if (Math.abs(activity.rubric.reduce((sum, item) => sum + item.weight, 0) - 100) > 0.001) throw new Error('Rubric weights must total 100.')
  if (activity.setup && !isSafeCommand(activity.setup.executable, activity.setup.args)) throw new Error('The setup command is not allowed.')
  const checks = [activity.verify, ...Object.values(activity.variants ?? {}).map((variant) => variant.verify)]
  if (checks.some((check) => check.kind === 'command' && !isSafeCommand(check.command.executable, check.command.args))) throw new Error('The verification command is not allowed.')
  if (Buffer.byteLength(JSON.stringify(activity)) > 900_000) throw new Error('The activity is too large to store safely.')
  return activity
}

export async function storeGeneratedActivity(auth: AuthContext, activity: ActivityManifest) {
  const validated = validateGeneratedActivity(activity)
  const { error } = await createAdminSupabaseClient().from('generated_activities').insert({
    user_id: auth.user.id, id: validated.id, manifest: JSON.parse(JSON.stringify(validated)) as Json,
  }).abortSignal(AbortSignal.timeout(10_000))
  if (error) throw error
}

export async function recordAssessment(auth: AuthContext, projectId: string, activity: ActivityManifest, result: VerificationResult, modelId: string, language: string, kind: 'command' | 'rubric') {
  const { data, error } = await createAdminSupabaseClient().rpc('record_assessment', {
    p_user_id: auth.user.id, p_project_id: projectId, p_assessment_id: result.requestId,
    p_activity_id: activity.id, p_score: result.score, p_passed: result.passed,
    p_ai_assessed: result.aiAssessed, p_feedback: result.feedback, p_concepts: activity.concepts,
    p_model_id: modelId, p_verification_kind: kind, p_language: language,
  }).abortSignal(AbortSignal.timeout(10_000))
  if (error?.message === 'ACTIVITY_PROJECT_NOT_FOUND') throw new ApiError(409, 'ACTIVITY_CHANGED', 'This project changed while it was being assessed. Reopen the activity.')
  if (error || !data) throw error ?? new Error('The assessment was not saved.')
  return data
}
