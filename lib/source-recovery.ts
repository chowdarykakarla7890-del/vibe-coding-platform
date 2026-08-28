import { z } from 'zod'
import { isSafeSnapshotPath, MAX_SOURCE_FILE_BYTES, sourceByteLength } from '@/lib/learning/snapshots'

const revision = z.number().int().min(0).max(2_147_483_647)
const content = z.string().refine((value) => !value.includes('\0') && sourceByteLength(value) <= MAX_SOURCE_FILE_BYTES)
const choice = z.enum(['saved', 'captured', 'merged'])
export const resolutionRequestSchema = z.discriminatedUnion('choice', [
  z.object({ choice: z.literal('saved'), revision }).strict(),
  z.object({ choice: z.literal('captured'), revision }).strict(),
  z.object({ choice: z.literal('merged'), revision, content }).strict(),
])
export const resolutionReceiptSchema = z.object({ id: z.string().uuid(), path: z.string().refine(isSafeSnapshotPath), choice, revision, deleted: z.boolean() })
export const conflictSummarySchema = z.object({ id: z.string().uuid(), path: z.string().refine(isSafeSnapshotPath),
  reason: z.string(), createdAt: z.string().datetime({ offset: true }), resolvedAt: z.string().datetime({ offset: true }).nullable() })
export const recoveryPageSchema = z.object({ conflicts: z.array(conflictSummarySchema).max(20), nextCursor: z.string().uuid().nullable(),
  paused: z.number().int().nonnegative().optional(),
  pending: z.number().int().nonnegative(), incomplete: z.number().int().nonnegative(), expired: z.number().int().nonnegative(), unresolved: z.number().int().nonnegative(), savedOnly: z.number().int().nonnegative() })
export const conflictDetailSchema = z.object({ conflict: conflictSummarySchema.extend({ captured: content.nullable() }),
  current: z.object({ content: content.nullable(), revision }),
  resolution: resolutionReceiptSchema.nullable(),
})
export type ConflictDetail = z.infer<typeof conflictDetailSchema>
export type ResolutionRequest = z.infer<typeof resolutionRequestSchema>

export const applyResolutionRequestSchema = z.object({
  sandboxId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  revision,
}).strict()
export const applyResolutionReceiptSchema = z.object({
  id: z.string().uuid(), sandboxId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  path: z.string().refine(isSafeSnapshotPath), revision, deleted: z.boolean(),
})
export type ApplyResolutionReceipt = z.infer<typeof applyResolutionReceiptSchema>

export function recoveryStatusText(page: z.infer<typeof recoveryPageSchema>) {
  if (page.unresolved) return `${page.unresolved} source conflict${page.unresolved === 1 ? '' : 's'} need review`
  if (page.savedOnly) return 'Saved resolutions available — review sandbox application'
  if (page.paused) return 'Background source saving paused — retry needed'
  if (page.incomplete || page.expired) return 'Some terminal changes may not be saved'
  if (page.pending) return 'Saving terminal changes…'
  return 'Source recovery'
}
