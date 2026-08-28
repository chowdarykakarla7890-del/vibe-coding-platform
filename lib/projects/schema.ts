import { z } from 'zod'

export const createProjectSchema = z.object({
  id: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(80),
  mode: z.enum(['playground', 'practice', 'debug', 'challenge', 'project', 'dsa']).default('playground'),
  language: z.string().trim().min(1).max(40).default('Any'),
  activityId: z.string().min(1).max(128).optional(),
  importedLocalId: z.string().min(1).max(128).optional(),
}).strict()

export const updateProjectSchema = z.object({
  title: z.string().trim().min(1).max(80).optional(),
  mode: z.enum(['playground', 'practice', 'debug', 'challenge', 'project', 'dsa']).optional(),
  language: z.string().trim().min(1).max(40).optional(),
  activityId: z.string().min(1).max(128).nullable().optional(),
  status: z.enum(['active', 'completed', 'archived']).optional(),
}).strict().refine((value) => Object.keys(value).length > 0)
