import { z } from 'zod'

export const gradingFailureSchema = z.enum(['timeout', 'output-limit', 'execution-error', 'invalid-output'])
const digest = z.string().regex(/^[a-f0-9]{64}$/)

/** Browser-safe projection. Never add raw inputs, program output or source. */
export const gradingSummarySchema = z.object({
  version: z.literal(1), checkVersion: z.string().regex(/^[a-zA-Z0-9._-]{1,80}$/),
  planDigest: digest, sourceDigest: digest, harnessDigest: digest, runtimeDigest: digest,
  caseCount: z.literal(24), status: z.enum(['prepared', 'complete']),
  passedCount: z.number().int().min(0).max(24).nullable(), compileFailure: gradingFailureSchema.nullable(),
  outcomes: z.array(z.enum(['passed', 'wrong-answer', ...gradingFailureSchema.options])).max(24),
  createdAt: z.string().datetime({ offset: true }), completedAt: z.string().datetime({ offset: true }).nullable(),
}).strict().refine(value => value.status === 'prepared'
  ? value.passedCount === null && value.compileFailure === null && value.outcomes.length === 0 && value.completedAt === null
  : value.completedAt !== null && value.passedCount === value.outcomes.filter(outcome => outcome === 'passed').length
    && (value.compileFailure ? value.outcomes.length === 0 : value.outcomes.length === value.caseCount))
export type GradingSummary = z.infer<typeof gradingSummarySchema>
