import z from 'zod/v3'

export const metadataSchema = z.object({
  model: z.string(),
  persistenceStatus: z.enum(['pending', 'complete', 'failed', 'interrupted']).optional(),
})

export type Metadata = z.infer<typeof metadataSchema>
