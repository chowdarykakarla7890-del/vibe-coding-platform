import { COMMAND_GATE_PROGRAM } from '../sandbox/runtime-programs.mjs'
import { COMMAND_OUTPUT_PROGRAM } from '../sandbox/output-program.mjs'

/** A separate PID namespace lets the kernel terminate the entire process tree
 * when the SDK stops/times out its unshare parent, including setsid/daemonized
 * descendants. A shell kill alone leaves children and output pipes alive.
 *
 * The user namespace maps the existing UID/GID, never root. Drop its temporary
 * namespace capabilities before executing any user code and prevent setuid
 * elevation across subsequent execs. Keep the existing /proc mount: the hosted
 * runtime denies unprivileged remounts. PID visibility is not the security
 * boundary; signal/namespace membership is enforced by the kernel.
 *
 * All options and binaries are fixed. User strings are distinct argv entries
 * after `--`, never interpolated into a privileged shell or script.
 */
export function guardedCommand(executable: string, args: string[]) {
  return {
    cmd: '/usr/bin/unshare',
    args: [
      '--user', '--map-current-user', '--keep-caps',
      '--pid', '--fork', '--kill-child=KILL', '--',
      '/usr/bin/setpriv', '--no-new-privs', '--bounding-set=-all',
      '--inh-caps=-all', '--ambient-caps=-all', '--', executable, ...args,
    ],
    sudo: false as const,
  }
}

/** Production commands additionally hold a read-only VM admission lock. The
 * existing kernel supervisor remains the process that owns the command tree. */
export function gatedCommand(executable: string, args: string[]) {
  const command = guardedCommand(executable, args)
  return { ...command, cmd: '/usr/bin/python3', args: ['-I', '-S', '-c', COMMAND_GATE_PROGRAM, ...command.args] }
}

/** Output encoding adds no privileges and stays inside the same kill tree. */
export function encodedCommand(executable: string, args: string[]) {
  return gatedCommand('/usr/bin/python3', ['-I', '-S', '-c', COMMAND_OUTPUT_PROGRAM, executable, ...args])
}
