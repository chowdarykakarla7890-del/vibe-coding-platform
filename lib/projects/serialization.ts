import { z } from 'zod'
import { learningProjectSchema } from '@/lib/learning/types'

const sandboxSessionSchema = z.object({
  sandbox_id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  status: z.enum(['creating', 'running', 'stopping', 'stopped', 'expired', 'failed']),
  expires_at: z.string().datetime({ offset: true }),
  preview_origin: z.string().regex(/^https:\/\/[a-zA-Z0-9-]+\.vercel\.run$/).nullable(),
})

export const projectRowSchema = z.object({
  id: z.string().uuid(), title: z.string(), mode: z.string(), language: z.string(),
  status: z.string(), activity_id: z.string().nullable(),
  created_at: z.string().datetime({ offset: true }), updated_at: z.string().datetime({ offset: true }),
  sandbox_sessions: z.array(sandboxSessionSchema).max(1).optional(),
}).transform((row) => ({
  id: row.id, title: row.title, mode: row.mode, language: row.language,
  status: row.status, activityId: row.activity_id ?? undefined,
  createdAt: Date.parse(row.created_at), updatedAt: Date.parse(row.updated_at),
  sandboxId: row.sandbox_sessions?.[0]?.sandbox_id,
  previewUrl: row.sandbox_sessions?.[0]?.status === 'running' && Date.parse(row.sandbox_sessions[0].expires_at) > Date.now()
    ? row.sandbox_sessions[0].preview_origin ?? undefined : undefined,
})).pipe(learningProjectSchema)

export const projectResponseSchema = z.object({ project: projectRowSchema })
export const projectsResponseSchema = z.object({ projects: z.array(projectRowSchema), nextCursor: z.string().uuid().nullable().optional() })
