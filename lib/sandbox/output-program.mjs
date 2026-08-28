/** Runs inside the existing unprivileged, killable PID namespace. Encode raw
 * pipe bytes BEFORE Sandbox's text log service can split UTF-8 characters. */
export const COMMAND_OUTPUT_PROGRAM = String.raw`
import base64, os, selectors, subprocess, sys

sequence = {1: 0, 2: 0}
def frame(fd, data):
    payload = base64.b64encode(data) if data is not None else b'.'
    record = b'CT1:' + str(sequence[fd]).encode('ascii') + b':' + payload + b'\n'
    while record:
        count = os.write(fd, record)
        record = record[count:]
    sequence[fd] += 1

try:
    child = subprocess.Popen(sys.argv[1:], stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0, close_fds=True)
except OSError:
    frame(2, b'The command could not be started. Check its executable and permissions.\n')
    frame(1, None); frame(2, None)
    sys.exit(127)

selector = selectors.DefaultSelector()
selector.register(child.stdout, selectors.EVENT_READ, 1)
selector.register(child.stderr, selectors.EVENT_READ, 2)
try:
    while selector.get_map():
        for key, _ in selector.select():
            data = os.read(key.fileobj.fileno(), 3072)
            if data:
                frame(key.data, data)
            else:
                selector.unregister(key.fileobj)
                key.fileobj.close()
                frame(key.data, None)
    code = child.wait()
    sys.exit(code if code >= 0 else 128 - code)
finally:
    selector.close()
    if child.poll() is None:
        child.kill()
        child.wait()
`
