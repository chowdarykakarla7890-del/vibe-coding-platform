import type { Session } from '@vercel/sandbox'
import { expect, it, vi } from 'vitest'
import { prepareLearningCompiler } from '@/lib/sandbox/learning-compiler'

it.each(['Java','C++'] as const)('prepares only the allowlisted %s compiler', async language => {
  const runCommand=vi.fn().mockResolvedValue({exitCode:0})
  await prepareLearningCompiler({runCommand} as Pick<Session,'runCommand'>,language)
  expect(runCommand).toHaveBeenCalledTimes(2)
  expect(runCommand.mock.calls[0][0]).toMatchObject({cmd:'/usr/bin/apt-get',args:['update'],sudo:true,timeoutMs:15_000})
  expect(runCommand.mock.calls[1][0]).toMatchObject({cmd:'/usr/bin/apt-get',args:['install','-y','--no-install-recommends',language==='Java'?'openjdk-21-jdk-headless':'g++'],timeoutMs:35_000})
})
it('does not continue after index failure', async () => {
  const runCommand=vi.fn().mockResolvedValue({exitCode:1})
  await expect(prepareLearningCompiler({runCommand} as Pick<Session,'runCommand'>,'Java')).rejects.toThrow('could not be prepared')
  expect(runCommand).toHaveBeenCalledOnce()
})
it('cancels even if the command transport ignores cancellation', async () => {
  const controller=new AbortController()
  const runCommand=vi.fn().mockImplementation(async()=>{controller.abort();return new Promise(()=>{})})
  await expect(prepareLearningCompiler({runCommand} as Pick<Session,'runCommand'>,'C++',controller.signal)).rejects.toMatchObject({name:'AbortError'})
  expect(runCommand).toHaveBeenCalledOnce()
  expect(runCommand.mock.calls[0][0].signal.aborted).toBe(true)
})
