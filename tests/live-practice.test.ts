import { expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Sandbox } from '@vercel/sandbox'
import { getSandboxCredentials } from '@/ai/sandbox'
import { prepareLearningCompiler } from '@/lib/sandbox/learning-compiler'
import { PRACTICE_ACTIVITIES } from '@/lib/learning/practice'
import { practiceSolutions } from './fixtures/practice-solutions'

// Opt-in paid VM only; no AI calls, account creation or customer source.
it.skipIf(process.env.RUN_LIVE_PRACTICE !== '1')('runs all practice starters and solutions on a fresh Linux VM', async () => {
  const name = `codetutor-practice-${randomUUID()}`
  let sandbox: Sandbox | undefined
  try {
    sandbox = await Sandbox.create({ name, ...getSandboxCredentials(), persistent: false, timeout: 900_000, signal: AbortSignal.timeout(45_000) })
    const vm = sandbox.currentSession()
    await prepareLearningCompiler(vm, 'Java')
    await prepareLearningCompiler(vm, 'C++')
    const root = '/tmp/codetutor-practice-matrix'
    const reactPackage = PRACTICE_ACTIVITIES.find(item => item.framework === 'React')!.starterFiles.find(file => file.path === 'package.json')!
    await vm.writeFiles([{ path: `${root}/package.json`, content: reactPackage.content }], { signal: AbortSignal.timeout(10_000) })
    const install = await vm.runCommand({ cmd: 'npm', args: ['install', '--ignore-scripts', '--no-audit', '--no-fund'], cwd: root, timeoutMs: 120_000, signal: AbortSignal.timeout(125_000) })
    expect(install.exitCode, 'Pinned React lesson dependencies install').toBe(0)
    for (const activity of PRACTICE_ACTIVITIES) {
      const cwd = `${root}/${activity.id}`
      await vm.writeFiles(activity.starterFiles.map(file => ({ path: `${cwd}/${file.path}`, content: file.content })), { signal: AbortSignal.timeout(10_000) })
      if (activity.verify.kind !== 'command') throw new Error('Missing lesson checks')
      const spec = activity.verify.command
      const run = () => vm.runCommand({ cmd: spec.executable, args: spec.args, cwd, timeoutMs: 45_000, signal: AbortSignal.timeout(50_000) })
      const starter = await run()
      expect(starter.exitCode, `${activity.id}: starter must fail`).not.toBe(0)
      expect((await starter.stdout()) + (await starter.stderr())).toContain('Complete the TODO')
      const solution = practiceSolutions[activity.id]
      await vm.writeFiles([{ path: `${cwd}/${solution.path}`, content: solution.content }], { signal: AbortSignal.timeout(10_000) })
      const complete = await run()
      expect(complete.exitCode, `${activity.id}: reference solution must pass`).toBe(0)
      if (activity.framework === 'React') {
        const build = await vm.runCommand({ cmd: 'npm', args: ['run', 'build'], cwd, timeoutMs: 30_000, signal: AbortSignal.timeout(35_000) })
        expect(build.exitCode, `${activity.id}: production build`).toBe(0)
      }
      console.log(`PASS ${activity.id}: failing starter, passing solution${activity.framework === 'React' ? ', pinned-dependency production build' : ''}`)
    }
  } finally {
    // A lost creation receipt still has a known test-only name. Do not resume.
    const cleanup = sandbox ?? await Sandbox.get({ name, resume: false, ...getSandboxCredentials(), signal: AbortSignal.timeout(15_000) })
    await cleanup.stop({ signal: AbortSignal.timeout(15_000) })
    console.log('Stopped disposable Practice matrix VM.')
  }
}, 900_000)
