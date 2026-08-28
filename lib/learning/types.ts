import { z } from 'zod'
import {
  hasSnapshotPathConflict,
  isSafeSnapshotPath,
  MAX_SOURCE_FILE_BYTES,
  sourceByteLength,
} from './snapshots'

export const activityModes = [
  'practice',
  'debug',
  'challenge',
  'project',
  'dsa',
] as const

export const activityModeSchema = z.enum(activityModes)
export type ActivityMode = z.infer<typeof activityModeSchema>

export const difficultySchema = z.enum([
  'beginner',
  'intermediate',
  'advanced',
])
export type Difficulty = z.infer<typeof difficultySchema>

export const sourceFileSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(240)
    .refine(isSafeSnapshotPath, 'Use a safe relative source-file path'),
  content: z.string().max(MAX_SOURCE_FILE_BYTES).refine(
    (content) => sourceByteLength(content) <= MAX_SOURCE_FILE_BYTES,
    'Source file exceeds 256 KB'
  ),
})

const sourceFilesSchema = z
  .array(sourceFileSchema)
  .min(1)
  .max(40)
  .refine(
    (files) => new Set(files.map((file) => file.path)).size === files.length,
    'Source-file paths must be unique'
  )
  .refine((files) => !hasSnapshotPathConflict(files.map((file) => file.path)), 'A source file cannot also be a folder')

export const learningProjectSchema = z.object({
  id: z.string().min(1).max(128),
  title: z.string().trim().min(1).max(80),
  mode: z.union([z.literal('playground'), activityModeSchema]),
  activityId: z.string().min(1).max(128).optional(),
  language: z.string().min(1).max(40),
  status: z.enum(['active', 'completed', 'archived']),
  sandboxId: z.string().min(1).max(128).optional(),
  previewUrl: z.string().url().max(2048).optional(),
  createdAt: z.number().finite().nonnegative(),
  updatedAt: z.number().finite().nonnegative(),
})

export const commandSpecSchema = z.object({
  executable: z.string().min(1).max(48),
  args: z.array(z.string().max(240)).max(24).default([]),
})

export const rubricItemSchema = z.object({
  id: z.string().min(1).max(48),
  label: z.string().min(1).max(160),
  weight: z.number().positive().max(100),
})

export const activityMilestoneSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  title: z.string().min(3).max(100),
  goal: z.string().min(10).max(600),
  acceptance: z.array(z.string().min(3).max(300)).min(1).max(5),
  check: commandSpecSchema,
})

export const activityManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,79}$/),
  mode: activityModeSchema,
  title: z.string().min(3).max(100),
  summary: z.string().min(10).max(360),
  language: z.string().min(1).max(40),
  framework: z.string().max(40).optional(),
  difficulty: difficultySchema,
  concepts: z.array(z.string().min(1).max(48)).min(1).max(10),
  estimatedMinutes: z.number().int().min(5).max(480),
  instructions: z.array(z.string().min(3).max(600)).min(1).max(12),
  milestones: z.array(activityMilestoneSchema).min(1).max(8)
    .refine(items => new Set(items.map(item => item.id)).size === items.length, 'Milestone IDs must be unique').optional(),
  lesson: z.object({
    explanation: z.string().min(20).max(2000),
    hints: z.array(z.string().min(3).max(600)).min(1).max(4),
    reflectionQuestions: z.array(z.string().min(3).max(300)).min(1).max(4),
  }).optional(),
  starterFiles: sourceFilesSchema,
  setup: commandSpecSchema.optional(),
  verify: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('command'), command: commandSpecSchema }),
    z.object({ kind: z.literal('rubric') }),
  ]),
  rubric: z.array(rubricItemSchema).min(1).max(10),
  variants: z.record(
    z.object({
      starterFiles: sourceFilesSchema,
      verify: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('command'), command: commandSpecSchema }),
        z.object({ kind: z.literal('rubric') }),
      ]),
    })
  ).optional(),
  examples: z
    .array(z.object({ input: z.string(), output: z.string() }))
    .max(8)
    .optional(),
  source: z.enum(['curated', 'generated']),
})

export type ActivityManifest = z.infer<typeof activityManifestSchema>

export type LearningProject = z.infer<typeof learningProjectSchema>

export interface Attempt {
  id: string
  projectId: string
  activityId: string
  score: number
  passed: boolean
  aiAssessed: boolean
  feedback: string[]
  concepts: string[]
  createdAt: number
}

export interface ProgressRecord {
  activityId: string
  attempts: number
  completed: boolean
  bestScore: number
  concepts: string[]
  updatedAt: number
}

export interface VerificationResult {
  passed: boolean
  score: number
  aiAssessed: boolean
  commandOutput: string
  feedback: string[]
  requestId: string
  submissionId?: string
  sourceDigest?: string
  sourceCurrent?: boolean
}

export interface FileSnapshot {
  id: string
  projectId: string
  path: string
  content: string
  size: number
  updatedAt: number
  revision?: number
}

export interface PortfolioProject {
  projectId: string
  title: string
  summary: string
  skills: string[]
  githubUrl?: string
  demoUrl?: string
  screenshot?: string
}

const externalUrlSchema = z.string().max(2048).refine((value) => {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}, 'Use an HTTP or HTTPS URL')

export const portfolioProjectSchema = z.object({
  projectId: z.string().min(1).max(128),
  title: z.string().max(100),
  summary: z.string().max(2000),
  skills: z.array(z.string().min(1).max(48)).max(30),
  githubUrl: externalUrlSchema.optional(),
  demoUrl: externalUrlSchema.optional(),
  screenshot: z.string()
    .max(1_400_000)
    .regex(/^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/i)
    .optional(),
})

export const portfolioDocumentSchema = z.object({
  id: z.literal('default'),
  displayName: z.string().max(100),
  headline: z.string().max(160),
  bio: z.string().max(4000),
  skills: z.array(z.string().min(1).max(48)).max(50),
  projects: z.array(portfolioProjectSchema).max(50),
  updatedAt: z.number().finite().nonnegative(),
})

export type PortfolioDocument = z.infer<typeof portfolioDocumentSchema>

export interface ChatRecord {
  projectId: string
  messages: unknown[]
  updatedAt: number
}
