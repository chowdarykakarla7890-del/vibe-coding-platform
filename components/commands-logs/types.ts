export interface Command {
  background?: boolean
  sandboxId: string
  cmdId: string
  startedAt: number
  command: string
  args: string[]
  exitCode?: number
  error?: string
  logs?: CommandLog[]
  logCursor?: string
  logsComplete?: boolean
  logsTruncated?: boolean
  logError?: string
  status?: 'running' | 'done' | 'error'
}

export interface CommandLog {
  data: string
  stream: 'stdout' | 'stderr'
  timestamp: number
}
