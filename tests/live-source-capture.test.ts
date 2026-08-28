import { expect, it } from 'vitest'
import { Sandbox } from '@vercel/sandbox'
import { captureSandboxSource } from '@/lib/sandbox/source-capture'
import { applySandboxSource } from '@/lib/sandbox/source-apply'
import { guardedCommand } from '@/lib/server/command-guard'
import { acknowledgeSandboxCapture } from '@/lib/sandbox/source-ack'
import { createHash } from 'node:crypto'

// Explicit opt-in: creates one paid, short-lived VM, always stopped below.
it.skipIf(process.env.RUN_LIVE_SOURCE_CAPTURE !== '1')('captures real terminal edits/deletions/Unicode with protected revision metadata', async () => {
  const credentials = { token: process.env.VERCEL_AUTH_TOKEN, teamId: process.env.VERCEL_TEAM_ID, projectId: process.env.VERCEL_PROJECT_ID }
  if (Object.values(credentials).some((value) => !value)) throw new Error('Load Sandbox credentials before running this test.')
  const sandbox = await Sandbox.create({ ...credentials, name: `codetutor-capture-check-${crypto.randomUUID()}`, persistent: false, timeout: 180_000, signal: AbortSignal.timeout(45_000) })
  try {
    const vm = sandbox.currentSession()
    await applySandboxSource(vm, [{ path: 'main.ts', content: 'saved', revision: 1 }, { path: 'deleted.ts', content: 'before delete', revision: 4 }])
    const changed = await vm.runCommand({ ...guardedCommand('node', ['-e', "const fs=require('fs');fs.writeFileSync('main.ts','terminal edit');fs.unlinkSync('deleted.ts');fs.writeFileSync('unicode.txt','🙂'.repeat(65536));fs.mkdirSync('.ssh');fs.writeFileSync('.ssh/secret','do not capture');fs.symlinkSync('/tmp','unsafe')"]), timeoutMs: 5_000, signal: AbortSignal.timeout(10_000) })
    expect(changed.exitCode).toBe(0)
    const result = await captureSandboxSource(vm, [])
    expect(result.entries.find((entry) => entry.path === 'main.ts')).toMatchObject({ kind: 'file', content: 'terminal edit', baseRevision: 1, pending: false })
    expect(result.entries.find((entry) => entry.path === 'deleted.ts')).toMatchObject({ kind: 'missing', baseRevision: 4, pending: false })
    expect(result.entries.find((entry) => entry.path === 'unicode.txt')).toMatchObject({ kind: 'file', content: '🙂'.repeat(65536), baseRevision: 0 })
    expect(result.entries.find((entry) => entry.path === 'unsafe')).toMatchObject({ kind: 'skipped', reason: 'unsafe' })
    expect(result.complete).toBe(false)
    expect(result.entries.some((entry) => entry.path.includes('secret'))).toBe(false)
    await expect(applySandboxSource(vm, [{ path: 'main.ts', content: 'late editor save', revision: 2 }])).rejects.toMatchObject({ code: 'SOURCE_WORKSPACE_CHANGED' })
    await expect(applySandboxSource(vm, [{ path: 'deleted.ts', content: 'late editor save', revision: 5 }])).rejects.toMatchObject({ code: 'SOURCE_WORKSPACE_CHANGED' })
    expect((await vm.readFileToBuffer({ path: 'main.ts' }))?.toString()).toBe('terminal edit')
    await acknowledgeSandboxCapture(vm, [{ path: 'main.ts', revision: 2, digest: createHash('sha256').update('terminal edit').digest('hex') }, { path: 'deleted.ts', revision: 5, digest: null }])
    const acknowledged = await captureSandboxSource(vm, ['deleted.ts'])
    expect(acknowledged.entries.find((entry) => entry.path === 'main.ts')).toMatchObject({ baseRevision: 2, pending: false })
    expect(acknowledged.entries.find((entry) => entry.path === 'deleted.ts')).toMatchObject({ kind: 'missing', baseRevision: 5, baseDigest: null, pending: false })
    await expect(applySandboxSource(vm, [{ path: 'deleted.ts', content: 'stale resurrection', revision: 4 }])).rejects.toMatchObject({ code: 'SOURCE_SUPERSEDED' })
    await applySandboxSource(vm, [{ path: 'deleted.ts', content: 'explicit recreation', revision: 6 }])
    expect((await vm.readFileToBuffer({ path: 'main.ts' }))?.toString()).toBe('terminal edit')
    expect((await vm.readFileToBuffer({ path: 'deleted.ts' }))?.toString()).toBe('explicit recreation')
    const cleanup = await vm.runCommand({ ...guardedCommand('sh', ['-c', 'test -z "$(find /tmp -maxdepth 1 -name \'codetutor-capture-*\' -print -quit)"']), timeoutMs: 3_000, signal: AbortSignal.timeout(5_000) })
    expect(cleanup.exitCode).toBe(0)
  } finally {
    await sandbox.stop({ signal: AbortSignal.timeout(15_000) })
    console.log('Stopped disposable source-capture VM.')
  }
}, 120_000)
