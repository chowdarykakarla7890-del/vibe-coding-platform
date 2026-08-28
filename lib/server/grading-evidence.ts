import 'server-only'
import { z } from 'zod'
import { createAdminSupabaseClient } from '@/lib/supabase/server'
import { gradingFailureSchema, gradingSummarySchema } from '@/lib/learning/grading-evidence'
import type { DSACase } from './dsa-cases'
import { ApiError, type AuthContext } from './api'

export interface GradingPlan {
  version: 1
  checkVersion: string
  activityId: string
  language: string
  sourceDigest: string
  harnessDigest: string
  runtimeDigest: string
  cases: DSACase[]
}
export const gradingReportSchema = z.object({
  compileFailure: gradingFailureSchema.nullable(),
  cases: z.array(z.object({ output: z.string().max(8192), failure: gradingFailureSchema.nullable(), passed: z.boolean() }).strict()
    .refine(value => !value.passed || value.failure === null)).max(24),
}).strict().refine(value => value.compileFailure ? value.cases.length === 0 : value.cases.length === 24)
export type GradingReport = z.infer<typeof gradingReportSchema>
const receiptSchema = z.object({ submissionId: z.string().uuid(), planDigest: z.string().regex(/^[a-f0-9]{64}$/), caseCount: z.literal(24) }).strict()

function assertResult(error: { message?: string } | null) {
  if (!error) return
  const code = error.message
  if (code === 'SUBMISSION_NOT_FOUND') throw new ApiError(404, code, 'Submission not found.')
  if (code === 'SUBMISSION_STORAGE_LIMIT') throw new ApiError(429, code, 'Submission evidence storage is full. Export work you need before deleting an unneeded project.')
  if (code === 'SUBMISSION_CLOSED') throw new ApiError(409, code, 'This submission has ended. Check its history before submitting again.')
  throw new ApiError(502, 'GRADING_EVIDENCE_UNAVAILABLE', 'The grading evidence could not be confirmed. No new score was awarded; check submission history before retrying.')
}

export async function prepareGradingEvidence(auth: AuthContext, submissionId: string, plan: GradingPlan, signal: AbortSignal) {
  signal.throwIfAborted()
  const { data, error } = await createAdminSupabaseClient().rpc('prepare_submission_grading', {
    p_user_id: auth.user.id, p_submission_id: submissionId, p_plan: JSON.parse(JSON.stringify(plan)),
  }).abortSignal(AbortSignal.any([signal, AbortSignal.timeout(10_000)]))
  signal.throwIfAborted()
  assertResult(error)
  const receipt = receiptSchema.safeParse(data)
  if (!receipt.success || receipt.data.submissionId !== submissionId) throw new ApiError(502, 'GRADING_EVIDENCE_UNAVAILABLE', 'The grading plan could not be confirmed. No code was executed.')
  return receipt.data
}

export async function finishGradingEvidence(auth: AuthContext, submissionId: string, planDigest: string, report: GradingReport, signal: AbortSignal) {
  signal.throwIfAborted()
  const parsed = gradingReportSchema.parse(report)
  const { data, error } = await createAdminSupabaseClient().rpc('finish_submission_grading', {
    p_user_id: auth.user.id, p_submission_id: submissionId, p_plan_digest: planDigest, p_report: parsed,
  }).abortSignal(AbortSignal.any([signal, AbortSignal.timeout(10_000)]))
  signal.throwIfAborted()
  assertResult(error)
  const summary = gradingSummarySchema.safeParse(data)
  if (!summary.success || summary.data.status !== 'complete' || summary.data.planDigest !== planDigest
    || summary.data.compileFailure !== parsed.compileFailure || summary.data.passedCount !== parsed.cases.filter(test => test.passed).length
    || JSON.stringify(summary.data.outcomes) !== JSON.stringify(parsed.cases.map(test => test.failure ?? (test.passed ? 'passed' : 'wrong-answer')))) {
    throw new ApiError(502, 'GRADING_EVIDENCE_UNAVAILABLE', 'The grading result could not be confirmed. No new score was awarded.')
  }
  return summary.data
}

export async function readGradingSummary(auth: AuthContext, projectId: string, submissionId: string, signal: AbortSignal) {
  signal.throwIfAborted()
  const { data, error } = await createAdminSupabaseClient().rpc('read_submission_grading_summary', {
    p_user_id: auth.user.id, p_project_id: projectId, p_submission_id: submissionId,
  }).abortSignal(signal)
  signal.throwIfAborted()
  assertResult(error)
  const result = gradingSummarySchema.nullable().safeParse(data)
  if (!result.success) throw new ApiError(502, 'GRADING_EVIDENCE_UNAVAILABLE', 'The saved grading summary could not be verified.')
  return result.data
}
