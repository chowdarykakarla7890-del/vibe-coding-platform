import { z } from 'zod'
import { sourceFileSchema } from './types'
import { gradingSummarySchema } from './grading-evidence'

export const submissionSummarySchema = z.object({
  id: z.string().uuid(), createdAt: z.string(), state: z.enum(['pending', 'complete', 'failed', 'interrupted']),
  failureCode: z.string().nullable(), language: z.string(), modelId: z.string(),
  score: z.number().min(0).max(100).nullable(), passed: z.boolean().nullable(),
  aiAssessed: z.boolean().nullable().default(null),
  sourceCurrentAtAssessment: z.boolean().nullable(),
})
export const submissionsPageSchema = z.object({ submissions: z.array(submissionSummarySchema).max(20), nextCursor: z.string().uuid().nullable() })
export const submissionDetailSchema = submissionSummarySchema.extend({
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.array(z.object({ path: z.string(), revision: z.number().int().positive() })).max(200),
  feedback: z.array(z.string()), title: z.string(),
  gradingSummary: gradingSummarySchema.nullable().default(null),
})
export const submittedFileSchema = sourceFileSchema.extend({ revision: z.number().int().positive() })

export function visibleSubmissionState(state: 'pending' | 'complete' | 'failed', expiresAt: string, now = Date.now()) {
  return state === 'pending' && Date.parse(expiresAt) <= now ? 'interrupted' : state
}
