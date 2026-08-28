import type { Command, CommandLog } from '@/components/commands-logs/types'
import { advancingLogCursor } from './protocol'

export const MAX_RETAINED_LOG_BYTES = 256 * 1024
export const MAX_RETAINED_LOG_RECORDS = 512
const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function appendCommandLog(command: Command, log: CommandLog, cursor?: string): Command {
  if (cursor !== undefined && !advancingLogCursor(cursor, command.logCursor)) return command
  let logs = [...(command.logs ?? []), log]
  let truncated = command.logsTruncated ?? false
  if (logs.length > MAX_RETAINED_LOG_RECORDS) { logs = logs.slice(-MAX_RETAINED_LOG_RECORDS); truncated = true }
  let bytes = logs.reduce((total, entry) => total + encoder.encode(entry.data).byteLength, 0)
  while (bytes > MAX_RETAINED_LOG_BYTES && logs.length > 1) {
    bytes -= encoder.encode(logs.shift()!.data).byteLength
    truncated = true
  }
  if (bytes > MAX_RETAINED_LOG_BYTES) {
    const encoded = encoder.encode(logs[0].data)
    let start = encoded.byteLength - MAX_RETAINED_LOG_BYTES
    while ((encoded[start] & 0xc0) === 0x80) start++
    logs[0] = { ...logs[0], data: decoder.decode(encoded.subarray(start)) }
    truncated = true
  }
  return { ...command, logs, logsTruncated: truncated, ...(cursor === undefined ? {} : { logCursor: cursor }) }
}
