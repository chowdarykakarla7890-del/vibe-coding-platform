import { z } from 'zod'

// Exact origin only: no credentials, paths, query strings, alternate ports,
// lookalike suffixes or nested hosts from cached/imported project records.
export const previewOriginSchema = z.string().max(256).regex(/^https:\/\/[a-zA-Z0-9-]+\.vercel\.run$/)
export const previewPortSchema = z.number().int().min(1024).max(65535)
export const previewRequestSchema = z.object({
  projectId: z.string().uuid(),
  port: previewPortSchema.optional(),
}).strict()
export const previewReceiptSchema = z.object({
  projectId: z.string().uuid(),
  sandboxId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  url: previewOriginSchema,
  port: previewPortSchema,
  ports: z.array(previewPortSchema).min(1).max(4),
}).refine(value => value.ports.includes(value.port) && new Set(value.ports).size === value.ports.length)
export type PreviewReceipt = z.infer<typeof previewReceiptSchema>
