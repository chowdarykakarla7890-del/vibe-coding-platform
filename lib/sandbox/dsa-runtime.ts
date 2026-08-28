import type { Session } from '@vercel/sandbox'
import type { DSALanguage } from '@/lib/learning/dsa-foundations'
import { abortableRead } from '@/lib/abortable-read'

const PREPARE = String.raw`
import json, os, shutil, stat
root='/var/lib/codetutor-grading-v1'
os.mkdir(root,0o755)
# This is called ONLY before a new VM is attached to a project, never on a
# learner-used VM. The platform image's Node binary is owned by the default
# user, so preserve a separate root-owned copy before that user can run code.
shutil.copyfile('/usr/local/bin/node',root+'/node')
os.chmod(root+'/node',0o555)
info=os.stat(root+'/node')
assert info.st_uid==0 and not (stat.S_IMODE(info.st_mode)&0o022)
print(json.dumps({'ready':True}))
`

/** Fresh VM only. Never promote a learner-modifiable binary to trusted after
 * a sandbox has been made available. Failed setup stops creation upstream. */
export async function prepareDSARuntime(vm: Pick<Session, 'runCommand'>, language: DSALanguage, callerSignal?: AbortSignal) {
  const signal = AbortSignal.any([AbortSignal.timeout(45_000), ...(callerSignal ? [callerSignal] : [])])
  signal.throwIfAborted()
  if (language === 'Java' || language === 'C++') {
    const index = await abortableRead(() => vm.runCommand({ cmd: '/usr/bin/apt-get', args: ['update'], cwd: '/',
      env: { DEBIAN_FRONTEND: 'noninteractive' }, sudo: true, timeoutMs: 15_000, signal }), signal)
    if (index.exitCode !== 0) throw new Error('The grading package index could not be prepared.')
    const packages = language === 'Java' ? ['openjdk-21-jdk-headless'] : ['g++']
    const install = await abortableRead(() => vm.runCommand({ cmd: '/usr/bin/apt-get', args: ['install', '-y', '--no-install-recommends', ...packages], cwd: '/',
      env: { DEBIAN_FRONTEND: 'noninteractive' }, sudo: true, timeoutMs: 35_000, signal }), signal)
    if (install.exitCode !== 0) throw new Error('The grading compiler could not be prepared.')
  }
  const result = await abortableRead(() => vm.runCommand({ cmd: '/usr/bin/python3', args: ['-I', '-S', '-c', PREPARE], cwd: '/',
    sudo: true, timeoutMs: 5000, signal }), signal)
  if (result.exitCode !== 0) throw new Error('The grading runtime could not be prepared.')
}
