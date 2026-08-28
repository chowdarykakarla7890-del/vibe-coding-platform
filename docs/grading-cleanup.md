# Interrupted grading: artifact cleanup

Implemented locally on 2026-08-28; not deployed. No database migration or credentials changed.

## Reproduced failure

The previous Stop implementation killed the registered host supervisor and its learner process tree, then removed the process record. SIGKILL bypassed the runner's Python `finally` block, leaving the staged source payload and copied runtime/scratch tree in `/tmp`. A real disposable-VM regression confirmed the payload remained after command completion and after all grading processes had stopped.

## Current protocol

- Registration publishes a small root-owned process record atomically before executing the fixed supervisor. Partial registration uses a recoverable `.pending` entry. The server binds the staged payload ID to the audited request ID before reserving resources. No client/model PID or cleanup directory is accepted.
- All new scratch files live in `/var/lib/codetutor-grading-v1/jobs/<run-id>`. The parent and job directories are root-owned and private. This replaces unregistered random temporary trees; it does not move or delete the student's workspace source.
- A kernel file lock serializes registration, completion, Stop and orphan cleanup. Lock acquisition is bounded to two seconds and releases automatically on process death.
- Stop first records an empty closed marker, verifies the registered PID's start time and owner, signals that exact process through a pidfd and waits up to two seconds for its exit notification. It then removes only that ID's private job and staged payload. A stale PID cannot signal an unrelated process. The application still waits for SDK command completion before recording a confirmed Stop.
- Cleanup uses a validated directory descriptor and Python's symlink-resistant `rmtree`; unexpected ownership, writable state, top-level symlinks, hard-linked records and malformed records fail closed. Nested links are unlinked without following their targets. See [Python's deletion guarantees](https://docs.python.org/3/library/shutil.html#shutil.rmtree) and [pidfd exit polling](https://man7.org/linux/man-pages/man2/pidfd_open.2.html).
- Normal completion uses the same cleanup path. A failed deletion retains its process record for retry. A failed custom Stop receipt is retried after command completion rather than treating process exit as proof that artifacts were removed.
- Failed source uploads and uncertain dispatches invoke cleanup even when no command ID was acknowledged. Unacknowledged dispatch still retains an unknown audit status; this does not invent confirmed command completion.
- On each subsequent grading launch, a bounded pass reclaims up to 32 dead/pending records. A rotating pass revisits up to 32 closed IDs to reclaim source uploads that arrived after Stop. Both passes preserve live or uncertain processes and never scan arbitrary temporary filenames.
- Tiny closed markers and a 36-byte sweep cursor remain until VM expiration to fence delayed dispatches. A cancelled/completed ID cannot be reused to launch another grading process. If a closed marker exists but its supervisor is still alive, both sweeping and duplicate dispatch preserve that run's artifacts until termination is confirmed.

## Verification

`tests/grading-cleanup.test.ts` executes the actual management functions against isolated filesystem fixtures, with only the root path, owner and Linux process operations substituted. It covers target isolation, duplicate registration, late launches/uploads, partial publication, failed cleanup and retry, unsafe metadata/paths, nested symlinks, bounded lock contention, dead-vs-live records, bounded/fair cleanup and uncertain process lookup. No local process is signalled.

Python 3.11+ is required for these tests. Set `CODETUTOR_TEST_PYTHON` when the workstation's `python3` is older; production Linux safeguards are not replaced by a weaker compatibility fallback.

The opt-in real-VM test passes cancellation with no remaining learner processes, no scratch directory or payload, preserved student source, repeated Stop, stop-before-launch fencing, recovery after an external SIGKILL, successful subsequent grading, private process records, stale-PID isolation and a duplicate dispatch against a closed-but-still-live job:

```sh
RUN_LIVE_DSA_CANCELLATION=1 node --env-file=.env.local node_modules/vitest/vitest.mjs run tests/live-grading-cancellation.test.ts --maxWorkers=1
```

The uniquely named VM stops in `finally`; cleanup can recover that same name if creation's acknowledgement is lost. This uses Sandbox resources but makes no AI requests or customer-data changes. The release gates record the full suite/build and all-language regression results separately.

Final checkpoint: 1,281 local tests pass (11 opt-ins skipped), including 19 filesystem-state tests and five new command-boundary cases. Lint, TypeScript, the Node 24 production build, whitespace checks, a local production HTTP smoke test and the production dependency audit pass. Both all-language live suites passed all 75 combinations and isolation checks in 410 seconds; the final expanded cancellation test passed in 23 seconds. Every temporary VM stopped successfully. These results do not establish deployment or full SaaS readiness.

## Remaining limits

Orphan reclamation after an external kill is triggered by the next grading launch; it is not an independent scheduler. If there is no later request, an orphan may remain until VM expiration. Historical unregistered random scratch directories from the old runner are intentionally not recursively swept. Expire/replace those old VMs instead of guessing their ownership.

Deletion/stop timeouts remain retryable, not a guarantee of completion. Heavy filesystem abuse, retained marker volume, general resource/load testing, actual deployment monitoring and exact randomized grading-case replay remain separate release work. No source snapshot or immutable submission is removed by grader cleanup.
