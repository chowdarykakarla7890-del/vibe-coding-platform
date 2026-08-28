import type { Command } from '@/components/commands-logs/types'
import type { Line } from '@/components/error-monitor/schemas'
import stripAnsi from 'strip-ansi'

export interface DiagnosticCandidate { key: string; line: Line }
const MAX_CONTEXT_CHARS = 4000

// Deliberately conservative: stderr is a channel, not an error severity.
// Unclassified output remains available for explicit "Help debug" requests.
export function isDiagnosticFailure(text: string) {
  const line = stripAnsi(text).trim()
  // Python/combined HTTP access records, including paths containing "error".
  const access = line.match(/^\S+ .*\[[^\]]+\]\s+"(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)\s+[^\r\n]*?\s+HTTP\/\d(?:\.\d)?"\s+(\d{3})\b/)
  if (access) return Number(access[1]) >= 500
  if (/^(?:(?:\[[^\]]+\]|\d{4}-\d\d-\d\dT\S+)\s*)?(?:INFO|DEBUG|TRACE|WARN(?:ING)?)\b[:\s]/i.test(line)) return false
  if (/^(?:\([^)]*\)\s*)?(?:DeprecationWarning|ExperimentalWarning|npm warn)\b/i.test(line)) return false
  if (/\b(?:no errors?|0 errors?)\b/i.test(line)) return false
  if (/^Command exited with code [1-9]\d*\./.test(line)) return true
  return /\b(?:[A-Z][A-Za-z0-9]*(?:Error|Exception)|error|fatal|panic|traceback|unhandled (?:rejection|exception)|segmentation fault|cannot find module|module not found|failed to (?:compile|build|resolve|load|start)|EADDRINUSE|ECONNREFUSED|ENOENT)\b/i.test(line)
}

export function diagnosticCandidates(commands: Command[]): DiagnosticCandidate[] {
  const candidates: DiagnosticCandidate[] = []
  for (const command of commands) {
    const initialCount = candidates.length
    const failed = typeof command.exitCode === 'number' && command.exitCode !== 0
    if (!command.background && !failed) continue
    for (const stream of ['stderr', 'stdout'] as const) {
      const logs = (command.logs ?? []).filter(log => log.stream === stream)
      // Join before splitting: transport records are arbitrary chunks, not lines.
      const lines = stripAnsi(logs.map(log => log.data).join('')).split(/\r?\n/)
      let failureIndex = -1
      for (let index = lines.length - 1; index >= 0; index--) {
        if (isDiagnosticFailure(lines[index])) { failureIndex = index; break }
      }
      if (failureIndex < 0) continue
      const signature = lines[failureIndex].trim().replace(/\[[\d/: A-Za-z+.-]+\]/g, '[time]').slice(0, 1000)
      const context = [lines[failureIndex].slice(0, 2000), ...lines.slice(failureIndex + 1, failureIndex + 8)].join('\n').slice(0, MAX_CONTEXT_CHARS)
      candidates.push({
        key: JSON.stringify([command.cmdId, stream, signature]),
        line: { command: command.command.slice(0, 2000), args: command.args.slice(0, 24).map(arg => arg.slice(0, 2000)), stream, data: context, timestamp: logs.at(-1)?.timestamp ?? command.startedAt },
      })
    }
    if (failed && candidates.length === initialCount) {
      candidates.push({ key: JSON.stringify([command.cmdId, 'exit', command.exitCode]), line: {
        command: command.command.slice(0, 2000), args: command.args.slice(0, 24).map(arg => arg.slice(0, 2000)),
        stream: 'stderr', data: `Command exited with code ${command.exitCode}.\n${(command.logs ?? []).map(log => stripAnsi(log.data)).join('').slice(-MAX_CONTEXT_CHARS)}`, timestamp: command.startedAt,
      } })
    }
  }
  return candidates.slice(-32)
}
