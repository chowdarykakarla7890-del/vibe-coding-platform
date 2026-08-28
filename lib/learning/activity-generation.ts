import { z } from 'zod'
import { activityModeSchema, difficultySchema } from './types'

export const ACTIVITY_GENERATION_TIMEOUT_MS = 120_000
export const ACTIVITY_RECEIPT_TIMEOUT_MS = 130_000
export const activityGenerationRequestSchema = z.object({
  mode: activityModeSchema,
  goal: z.string().trim().min(5).max(800),
  language: z.string().trim().min(1).max(40),
  difficulty: difficultySchema,
  modelId: z.string().optional(),
}).strict()
export type ActivityGenerationRequest = z.infer<typeof activityGenerationRequestSchema>
