import { describe, expect, it } from 'vitest'
import { guardedCommand } from '@/lib/server/command-guard'

describe('kernel command guard', () => {
  it('uses unprivileged PID isolation, tree cleanup and capability removal', () => {
    const command = guardedCommand('node', ['script.js'])
    expect(command.cmd).toBe('/usr/bin/unshare')
    expect(command.sudo).toBe(false)
    for (const option of ['--user', '--map-current-user', '--pid', '--fork', '--kill-child=KILL', '--no-new-privs', '--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all']) expect(command.args).toContain(option)
    expect(command.args).not.toContain('--map-root-user')
    expect(command.args).not.toContain('--mount-proc')
  })
  it('keeps executable and arguments verbatim after the guard option terminator', () => {
    const args = ['a b', '$(not-interpolated)', ';not-interpolated', '--sudo']
    const command = guardedCommand('-not-an-option', args)
    expect(command.args.slice(-6)).toEqual(['--', '-not-an-option', ...args])
    expect(args).toEqual(['a b', '$(not-interpolated)', ';not-interpolated', '--sudo'])
  })
})
