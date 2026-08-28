import z from 'zod/v3'

export const metadataSchema = z.object({
  model: z.string(),
  requestId: z.string().uuid().optional(),
  persistenceStatus: z.enum(['pending', 'complete', 'failed', 'interrupted']).optional(),
})

export type Metadata = z.infer<typeof metadataSchema>
