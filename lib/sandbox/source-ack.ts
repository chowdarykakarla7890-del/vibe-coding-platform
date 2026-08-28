import { createHash, randomUUID } from 'node:crypto'
import type { Session } from '@vercel/sandbox'
import { z } from 'zod'
import { abortableRead } from '@/lib/abortable-read'
import { isSafeSnapshotPath } from '@/lib/learning/snapshots'
import { SOURCE_CAPTURE_FILESYSTEM_PROGRAM, SourceCaptureError } from './source-capture'

const receiptSchema = z.object({
  path: z.string().refine(isSafeSnapshotPath),
  revision: z.number().int().positive().max(2_147_483_647),
  digest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
})
export type SourceCaptureAcknowledgement = z.infer<typeof receiptSchema>
const batchSchema = z.array(receiptSchema).min(1).max(400)
  .refine((items) => new Set(items.map((item) => item.path)).size === items.length)

/** Advances only protected metadata, after durable capture and a fresh digest
 * check. It never rewrites source to make a capture appear successful. */
export const SOURCE_ACK_PROGRAM = SOURCE_CAPTURE_FILESYSTEM_PROGRAM + String.raw`

def acknowledge(items, workspace, state_path='/var/lib/codetutor-source-v1', trusted_uid=0):
    if not isinstance(items, list) or not 1 <= len(items) <= 400: fail('INVALID_SOURCE')
    paths = set()
    for item in items:
        if not isinstance(item, dict): fail('INVALID_SOURCE')
        path, revision, digest = item.get('path'), item.get('revision'), item.get('digest')
        if not safe_source(path) or path in paths or type(revision) is not int or not 1 <= revision <= 2147483647: fail('INVALID_SOURCE')
        if 'digest' not in item or (digest is not None and (not isinstance(digest, str) or not re.fullmatch('[0-9a-f]{64}', digest))): fail('INVALID_SOURCE')
        paths.add(path)
    try: os.mkdir(state_path, 0o700)
    except FileExistsError: pass
    state = open_directory(state_path, trusted_uid)
    root = lock = None
    try:
        if stat.S_IMODE(os.fstat(state).st_mode) & 0o077: fail('SOURCE_JOURNAL_INVALID')
        lock = os.open('apply.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=state)
        deadline = time.monotonic() + 5
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline: fail('SOURCE_APPLY_BUSY')
                time.sleep(0.02)
        root = os.open(workspace, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        owner = os.fstat(root).st_uid
        prepared = []
        for item in items:
            key = hashlib.sha256(item['path'].encode()).hexdigest() + '.json'
            record = read_record(state, key)
            if record['revision'] > item['revision']: fail('SOURCE_SUPERSEDED')
            if record['revision'] == item['revision'] and record['digest'] != item['digest']: fail('SOURCE_REVISION_MISMATCH')
            try: data = read_source(root, item['path'], owner)
            except FileNotFoundError: data = None
            digest = hashlib.sha256(data).hexdigest() if data is not None else None
            if digest != item['digest']: fail('SOURCE_WORKSPACE_CHANGED')
            prepared.append((key, item))
        for key, item in prepared:
            record = {**item, 'appliedRevision': item['revision'], 'appliedDigest': item['digest']}
            atomic_write(state, key, json.dumps(record, separators=(',', ':')).encode(), trusted_uid, os.fstat(state).st_gid, 0o600)
        return items
    finally:
        if root is not None: os.close(root)
        if lock is not None: os.close(lock)
        os.close(state)

def ack_main():
    stage, expected, workspace = sys.argv[1:]
    if not re.fullmatch(r'/tmp/codetutor-capture-ack-[0-9a-f-]{36}\.json', stage) or not re.fullmatch('[0-9a-f]{64}', expected): fail('INVALID_SOURCE')
    try:
        fd = os.open(stage, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode): fail('INVALID_SOURCE')
            data = stream.read(512 * 1024 + 1)
        if len(data) > 512 * 1024 or hashlib.sha256(data).hexdigest() != expected: fail('SOURCE_PAYLOAD_CHANGED')
        print(json.dumps({'acknowledged': acknowledge(json.loads(data), workspace)}, ensure_ascii=True))
    finally:
        try: os.unlink(stage)
        except FileNotFoundError: pass

if __name__ == '__main__':
    try: ack_main()
    except ApplyFailure as error:
        print(json.dumps({'error': error.code}))
        sys.exit(1)
    except BaseException:
        print(json.dumps({'error': 'SOURCE_ACK_FAILED'}))
        sys.exit(1)
`

export async function acknowledgeSandboxCapture(vm: Pick<Session, 'cwd' | 'writeFiles' | 'runCommand'>, receipts: SourceCaptureAcknowledgement[], callerSignal?: AbortSignal) {
  const parsed = batchSchema.safeParse(receipts)
  if (!parsed.success || !vm.cwd || !vm.cwd.startsWith('/') || vm.cwd === '/' || vm.cwd.includes('\0')) throw new SourceCaptureError('INVALID_SOURCE')
  const signal = AbortSignal.any([AbortSignal.timeout(20_000), ...(callerSignal ? [callerSignal] : [])])
  const data = Buffer.from(JSON.stringify(parsed.data))
  const stage = `/tmp/codetutor-capture-ack-${randomUUID()}.json`
  try {
    signal.throwIfAborted()
    await vm.writeFiles([{ path: stage, content: data, mode: 0o600 }], { signal })
    const command = await vm.runCommand({ cmd: '/usr/bin/python3', args: ['-I', '-S', '-c', SOURCE_ACK_PROGRAM, stage, createHash('sha256').update(data).digest('hex'), vm.cwd], cwd: '/', sudo: true, timeoutMs: 10_000, signal })
    const result: unknown = JSON.parse(await abortableRead(() => command.stdout(), signal))
    if (command.exitCode !== 0) {
      const error = z.object({ error: z.string().regex(/^SOURCE_[A-Z_]+$|^INVALID_SOURCE$/) }).safeParse(result)
      throw new SourceCaptureError(error.success ? error.data.error : 'SOURCE_ACK_FAILED')
    }
    const response = z.object({ acknowledged: batchSchema }).parse(result)
    if (response.acknowledged.length !== receipts.length || response.acknowledged.some((item, index) =>
      item.path !== receipts[index].path || item.revision !== receipts[index].revision || item.digest !== receipts[index].digest)) throw new SourceCaptureError('SOURCE_RECEIPT_INVALID')
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof SourceCaptureError) throw error
    throw new SourceCaptureError('SOURCE_ACK_FAILED')
  } finally {
    await vm.runCommand({ cmd: '/usr/bin/rm', args: ['-f', '--', stage], cwd: '/', sudo: true, timeoutMs: 1_000, signal: AbortSignal.timeout(3_000) }).catch(() => undefined)
  }
}
