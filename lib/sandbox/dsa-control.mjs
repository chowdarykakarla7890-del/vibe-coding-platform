import { DSA_STATE_PROGRAM } from './dsa-state.mjs'

// SDK kill targets the unprivileged launch wrapper, not necessarily its sudo
// child. Register the fixed root supervisor before exec; only trusted server
// management can read/write this directory. Neither source nor a client PID
// is accepted as authority to stop a process.
export const DSA_REGISTER_PROGRAM = DSA_STATE_PROGRAM + String.raw`
try:
    register_grading(sys.argv[1])
    os.execv('/usr/bin/unshare',['/usr/bin/unshare']+sys.argv[2:])
except BaseException:
    print('The trusted grading supervisor could not start.',file=sys.stderr)
    sys.exit(75)
`

export const DSA_STOP_PROGRAM = DSA_STATE_PROGRAM + String.raw`
try:
    stop_grading(sys.argv[1])
except BaseException as error:
    if isinstance(error,SystemExit): raise
    print('Trusted grading termination or artifact cleanup could not be confirmed.',file=sys.stderr)
    sys.exit(75)
`
