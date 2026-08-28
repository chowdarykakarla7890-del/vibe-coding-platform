import { z } from 'zod'
import { activityManifestSchema } from './types'

export const progressRecordSchema = z.object({
  activityId: z.string().min(1).max(128), attempts: z.number().int().nonnegative(), completed: z.boolean(),
  bestScore: z.number().min(0).max(100), concepts: z.array(z.string().max(48)), updatedAt: z.number().finite().nonnegative(),
})
export const progressPageSchema = z.object({ progress: z.array(progressRecordSchema).max(100), nextCursor: z.string().nullable() })
export const activitiesPageSchema = z.object({ activities: z.array(activityManifestSchema).max(100), nextCursor: z.string().nullable() })
