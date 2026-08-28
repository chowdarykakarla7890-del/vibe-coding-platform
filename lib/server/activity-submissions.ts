import 'server-only'
import { z } from 'zod'
import { activityManifestSchema, sourceFileSchema, type ActivityManifest, type VerificationResult } from '@/lib/learning/types'
import { createAdminSupabaseClient } from '@/lib/supabase/server'
import { ApiError, type AuthContext } from './api'

const recordSchema = z.object({
  id: z.string().uuid(), project_id: z.string().uuid(), user_id: z.string().uuid(), source_id: z.string().uuid(),
  source_versions: z.array(z.object({ path: z.string(), revision: z.number().int().positive() })).min(1).max(200),
  manifest: activityManifestSchema, language: z.string(), model_id: z.string(), reflection: z.string(),
  state: z.enum(['pending', 'complete', 'failed']), expires_at: z.string().datetime({ offset: true }),
})
const sourceSchema = z.object({ digest: z.string().regex(/^[a-f0-9]{64}$/), files: z.array(sourceFileSchema).min(1).max(200) })
export type ActivitySubmission = z.infer<typeof recordSchema> & z.infer<typeof sourceSchema>

const errors: Record<string, [number, string]> = {
  ACTIVITY_PROJECT_NOT_FOUND: [409, 'The project activity or language changed. Reopen it before submitting.'],
  SUBMISSION_CONFLICT: [409, 'This submission request already belongs to different inputs.'],
  SUBMISSION_SOURCE_MISSING: [409, 'Save your activity source before submitting. No score was saved.'],
  SOURCE_REVIEW_REQUIRED: [409, 'Review unresolved source conflicts before submitting.'],
  SOURCE_CAPTURE_PENDING: [409, 'Wait for terminal commands and source saving to finish before submitting.'],
  SUBMISSION_STORAGE_LIMIT: [429, 'Submission history has reached its storage limit. Download any submitted files you need before deleting an unneeded project.'],
  SUBMISSION_NOT_FOUND: [404, 'Submission not found.'],
  SUBMISSION_CLOSED: [409, 'This submission has ended. Check its history before submitting again.'],
  ASSESSMENT_CONFLICT: [409, 'This submission already has a different saved assessment. Open its history.'],
}
function submissionError(error: { message?: string } | null, fallback: string): never {
  const known = error?.message && errors[error.message]
  if (known) throw new ApiError(known[0], error!.message!, known[1])
  throw new ApiError(502, 'SUBMISSION_UNAVAILABLE', fallback)
}

export async function beginActivitySubmission(auth: AuthContext, projectId: string, id: string, activity: ActivityManifest,
  language: string, modelId: string, reflection: string, signal: AbortSignal): Promise<ActivitySubmission> {
  const manifest = activityManifestSchema.parse(activity)
  const admin = createAdminSupabaseClient()
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(15_000)])
  const { data, error } = await admin.rpc('begin_activity_submission', {
    p_user_id: auth.user.id, p_project_id: projectId, p_submission_id: id,
    p_manifest: JSON.parse(JSON.stringify(manifest)), p_language: language, p_model_id: modelId, p_reflection: reflection,
  }).abortSignal(deadline)
  if (error) submissionError(error, 'The saved-source submission could not be confirmed. Check history before retrying.')
  const record = recordSchema.parse(data)
  if (record.id !== id || record.user_id !== auth.user.id || record.project_id !== projectId || record.state !== 'pending') {
    throw new ApiError(409, 'SUBMISSION_CLOSED', 'This submission is no longer available for assessment. Open its history.')
  }
  const source = await auth.supabase.from('submission_sources').select('digest,files')
    .eq('id', record.source_id).eq('project_id', projectId).eq('user_id', auth.user.id).abortSignal(deadline).single()
  if (source.error) submissionError(source.error, 'The retained submission source could not be loaded. Please retry.')
  const parsed = sourceSchema.parse(source.data)
  if (parsed.files.length !== record.source_versions.length || parsed.files.some((file, index) => file.path !== record.source_versions[index].path)) {
    throw new ApiError(502, 'SUBMISSION_SOURCE_INVALID', 'The saved submission evidence could not be verified.')
  }
  return { ...record, ...parsed }
}

/** No VM reads, editable learner tests, or mutable project context is used. */
export function submissionEvidence(submission: ActivitySubmission) {
  const variant = submission.manifest.variants?.[submission.language]
  const required = variant?.starterFiles ?? submission.manifest.starterFiles
  const paths = new Set(submission.files.map((file) => file.path))
  if (!submission.files.some((file) => file.content.trim()) || required.some((file) => !paths.has(file.path))) {
    throw new ApiError(409, 'SUBMISSION_SOURCE_MISSING', 'The saved submission is missing activity source. Save the required files before resubmitting.')
  }
  const evidence = JSON.stringify(submission.files)
  // Keep the complete immutable source in storage for future test runners, but
  // do not silently score a truncated AI input as if the whole project was read.
  if (Buffer.byteLength(evidence, 'utf8') > 64_000) {
    throw new ApiError(413, 'SUBMISSION_EVIDENCE_TOO_LARGE', 'The saved submission exceeds the current 64 KB AI assessment limit. Its source is retained, but no score was saved.')
  }
  return evidence
}

export async function recordSubmissionAssessment(auth: AuthContext, submissionId: string, result: VerificationResult) {
  const { data, error } = await createAdminSupabaseClient().rpc('record_submission_assessment', {
    p_user_id: auth.user.id, p_submission_id: submissionId, p_score: result.score, p_passed: result.passed,
    p_ai_assessed: result.aiAssessed, p_feedback: result.feedback, p_verification_kind: result.aiAssessed ? 'rubric' : 'command',
  }).abortSignal(AbortSignal.timeout(10_000))
  if (error) submissionError(error, 'The assessment save could not be confirmed. Check submission history before retrying.')
  const receipt = z.object({ id: z.string().uuid(), sourceCurrent: z.boolean() }).safeParse(data)
  if (!receipt.success || receipt.data.id !== submissionId) {
    throw new ApiError(502, 'ASSESSMENT_RECEIPT_INVALID', 'The saved assessment could not be confirmed. Check submission history before retrying.')
  }
  return receipt.data
}

export async function failActivitySubmission(auth: AuthContext, id: string, code: string) {
  const { error } = await createAdminSupabaseClient().rpc('fail_activity_submission', {
    p_user_id: auth.user.id, p_submission_id: id, p_code: /^[A-Z_]{3,80}$/.test(code) ? code : 'ASSESSMENT_FAILED',
  }).abortSignal(AbortSignal.timeout(5_000))
  if (error) console.error('Submission cleanup deferred', { submissionId: id, code: error.code })
}
