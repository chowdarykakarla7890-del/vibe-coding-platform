import { describe, expect, it } from 'vitest'
import { diagnosticCandidates, isDiagnosticFailure } from '@/lib/commands/diagnostic-candidates'
import type { Command } from '@/components/commands-logs/types'

function command(data: string, patch: Partial<Command> = {}): Command {
  return { sandboxId: 's1', cmdId: 'c1', command: 'python3', args: ['-m', 'http.server'], startedAt: 1, background: true, logs: [{ stream: 'stderr', data, timestamp: 1 }], ...patch }
}
describe('diagnostic candidates', () => {
  it.each([
    '100.64.0.1 - - [27/Aug/2026 23:42:18] "GET / HTTP/1.1" 200 -',
    '100.64.0.1 - - [27/Aug/2026 23:42:18] "GET /error HTTP/1.1" 304 -',
    '100.64.0.1 - - [27/Aug/2026 23:42:18] "GET /favicon.ico HTTP/1.1" 404 -',
    'INFO: server ready', 'DEBUG: error handler installed', 'WARNING: development only',
    '(node:15) ExperimentalWarning: Example', 'DeprecationWarning: use new API', 'npm warn deprecated package',
    'compiled successfully', 'No errors found', '0 errors', 'Serving HTTP on 0.0.0.0 port 3000',
  ])('does not send routine output to AI: %s', data => {
    expect(isDiagnosticFailure(data)).toBe(false)
    expect(diagnosticCandidates([command(data)])).toEqual([])
  })
  it.each(['TypeError: undefined', 'Traceback (most recent call last):', 'java.lang.IllegalStateException: failed', 'src/main.cpp:4: error: missing symbol', 'panic: invalid memory address', 'Error: listen EADDRINUSE', 'failed to compile', 'Segmentation fault', 'Command exited with code 2.', '100.64.0.1 - - [27/Aug/2026 23:42:18] "GET / HTTP/1.1" 500 -'])('keeps real failure signals: %s', data => {
    expect(isDiagnosticFailure(data)).toBe(true)
    expect(diagnosticCandidates([command(data)])).toHaveLength(1)
  })
  it('joins partial records before detecting a failure on either output stream', () => {
    const input = command('', { logs: [{ stream: 'stdout', data: 'Type', timestamp: 1 }, { stream: 'stdout', data: 'Error: invalid\n at main.js:2', timestamp: 2 }] })
    expect(diagnosticCandidates([input])[0].line.data).toContain('TypeError: invalid')
    expect(diagnosticCandidates([input])[0].line.stream).toBe('stdout')
  })
  it('does not mutate commands, depend on log count, or include transport errors as source errors', () => {
    const original = command('TypeError: first\n')
    const before = structuredClone(original)
    const first = diagnosticCandidates([original])[0]
    expect(original).toEqual(before)
    const second = diagnosticCandidates([command('TypeError: second\n')])[0]
    expect(first.key).not.toBe(second.key)
    expect(diagnosticCandidates([command('', { status: 'error', error: 'Sandbox expired', logError: 'Connection lost' })])).toEqual([])
  })
  it('preserves failures after long startup output and deduplicates HTTP timestamps', () => {
    const data = `${'ready '.repeat(5000)}\nTypeError: failed\n  at main.js:3`
    expect(diagnosticCandidates([command(data)])[0].line.data).toContain('TypeError: failed')
    const access = '100.64.0.1 - - [27/Aug/2026 23:42:18] "GET / HTTP/1.1" 500 -'
    expect(diagnosticCandidates([command(access)])[0].key).toBe(diagnosticCandidates([command(access.replace('23:42:18', '23:44:00'))])[0].key)
  })
  it('reports failed exits with bounded output, not successful foreground commands', () => {
    expect(diagnosticCandidates([command('Error fixture text', { background: false, exitCode: 0 })])).toEqual([])
    const result = diagnosticCandidates([command('x'.repeat(20_000), { background: false, exitCode: 2 })])
    expect(result[0].line.data).toContain('Command exited with code 2.')
    expect(result[0].line.data.length).toBeLessThan(4100)
  })
})
