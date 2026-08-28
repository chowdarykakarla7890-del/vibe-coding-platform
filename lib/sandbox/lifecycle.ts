import { z } from 'zod'

export const shutdownSchema = z.object({
  jobId: z.string().uuid(),
  state: z.enum(['saving', 'retryable', 'saved', 'incomplete']),
  saved: z.boolean(),
  hasConflicts: z.boolean(),
})
export const sandboxLifecycleSchema = z.object({
  status: z.enum(['ok', 'running', 'stopping', 'stopped']),
  shutdown: shutdownSchema.optional(),
})
export type SandboxLifecycle = z.infer<typeof sandboxLifecycleSchema>
