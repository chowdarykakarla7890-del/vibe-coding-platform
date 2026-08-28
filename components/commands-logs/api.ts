import stripAnsi from 'strip-ansi'
import { z } from 'zod'
import { commandStreamRecordSchema, COMMAND_LOG_WINDOW_BYTES, INITIAL_LOG_CURSOR, type CommandStreamRecord } from '@/lib/commands/protocol'
import { cloudOperation } from '@/lib/learning/cloud-request'
import { abortableRead } from '@/lib/abortable-read'

export type { CommandStreamRecord } from '@/lib/commands/protocol'

const commandSchema = z.object({
  sandboxId: z.string(), cmdId: z.string(), startedAt: z.number().finite(),
  status: z.enum(['running', 'done']), exitCode: z.number().int().nullable(),
})
const apiErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), requestId: z.string().optional() }) })

export class CommandOutputError extends Error {
  constructor(message: string, public code: string, public status: number, public retryAfterMs = 0) {
    super(message)
    this.name = 'CommandOutputError'
  }
}
async function ensureOk(response: Response) {
  if (response.ok) return
  const payload = apiErrorSchema.safeParse(await response.json().catch(() => null))
  const retryAfter = Number(response.headers.get('retry-after') ?? 0)
  throw new CommandOutputError(
    payload.success ? payload.data.error.message : 'The command output could not be loaded.',
    payload.success ? payload.data.error.code : 'COMMAND_OUTPUT_FAILED', response.status,
    Number.isFinite(retryAfter) ? Math.max(0, Math.min(retryAfter * 1000, 30_000)) : 0,
  )
}
function parseRecord(line: string): CommandStreamRecord {
  try { return commandStreamRecordSchema.parse(JSON.parse(line)) }
  catch { throw new CommandOutputError('The command output response was invalid. Retry to reconnect.', 'INVALID_COMMAND_STREAM', 502) }
}

export async function* streamCommandLogs(sandboxId: string, cmdId: string, cursor = INITIAL_LOG_CURSOR, signal?: AbortSignal): AsyncGenerator<CommandStreamRecord> {
  const operation = cloudOperation()
  const readSignal = AbortSignal.any([AbortSignal.timeout(25_000), ...(signal ? [signal] : [])])
  const query = new URLSearchParams({ cursor: String(cursor) })
  const response = await operation.fetch(
    `/api/sandboxes/${encodeURIComponent(sandboxId)}/cmds/${encodeURIComponent(cmdId)}/logs?${query}`,
    { headers: { Accept: 'application/x-ndjson' }, signal: readSignal, cache: 'no-store' },
  )
  await ensureOk(response)
  if (!response.body) throw new CommandOutputError('The command output stream was empty.', 'EMPTY_COMMAND_STREAM', 502)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let received = 0
  try {
    while (true) {
      const { done, value } = await abortableRead(() => reader.read(), readSignal)
      operation.assertActive()
      received += value?.byteLength ?? 0
      if (received > COMMAND_LOG_WINDOW_BYTES + 1024) throw new CommandOutputError('The command output window exceeded its limit.', 'INVALID_COMMAND_STREAM', 502)
      buffer += decoder.decode(value, { stream: !done })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      if (done && buffer.trim()) { lines.push(buffer); buffer = '' }
      for (const line of lines) {
        if (!line) continue
        const record = parseRecord(line)
        if (record.type === 'error') throw new CommandOutputError(record.error.message, record.error.code, record.status)
        yield record.type === 'log' ? { ...record, data: stripAnsi(record.data) } : record
        if (record.type === 'status') return
      }
      if (done) throw new CommandOutputError('The log connection ended before its status arrived.', 'INCOMPLETE_COMMAND_STREAM', 502)
    }
  } finally {
    // Do not let a broken transport hold cleanup indefinitely.
    void reader.cancel().catch(() => undefined)
  }
}

export async function fetchCommand(sandboxId: string, cmdId: string, signal?: AbortSignal) {
  const response = await cloudOperation().fetch(`/api/sandboxes/${encodeURIComponent(sandboxId)}/cmds/${encodeURIComponent(cmdId)}`, {
    signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]), cache: 'no-store',
  })
  await ensureOk(response)
  return commandSchema.parse(await response.json())
}
