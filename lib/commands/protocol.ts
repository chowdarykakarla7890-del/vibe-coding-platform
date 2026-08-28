import { z } from 'zod'

// The SDK may interleave stdout/stderr differently on replay. Checkpoint
// consumed UTF-8 bytes independently; transport ordering is not an identity.
export const INITIAL_LOG_CURSOR = 'v3.0.0'
export function parseLogCursor(value: string) {
  const match = /^v3\.(\d+)\.(\d+)$/.exec(value)
  if (!match) return undefined
  const stdout = Number(match[1])
  const stderr = Number(match[2])
  if (![stdout, stderr].every((offset) => Number.isSafeInteger(offset) && offset >= 0 && offset < Number.MAX_SAFE_INTEGER)) return undefined
  return { stdout, stderr }
}
export function advancingLogCursor(next: string, previous = INITIAL_LOG_CURSOR) {
  const a = parseLogCursor(next)
  const b = parseLogCursor(previous)
  return !!a && !!b && a.stdout >= b.stdout && a.stderr >= b.stderr && (a.stdout > b.stdout || a.stderr > b.stderr)
}
export const logCursorSchema = z.string().refine((value) => !!parseLogCursor(value))
export const commandIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/)
export const commandStreamRecordSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('log'), cursor: logCursorSchema, data: z.string().max(8192), stream: z.enum(['stdout', 'stderr']), timestamp: z.number().finite() }),
  z.object({ type: z.literal('status'), status: z.enum(['running', 'done', 'expired']), exitCode: z.number().int().nullable() }),
  z.object({ type: z.literal('error'), error: z.object({ code: z.string(), message: z.string(), requestId: z.string() }), status: z.number().int() }),
])
export type CommandStreamRecord = z.infer<typeof commandStreamRecordSchema>
export const COMMAND_LOG_WINDOW_MS = 20_000
export const COMMAND_LOG_WINDOW_BYTES = 64 * 1024
