# Source-preserving sandbox shutdown

The local application now reserves shutdown durably before closing the VM. Hosted migration `20260827130521_durable_sandbox_shutdown.sql` is applied and generated types are checked in. The application and scheduler are **not deployed**, so this is not a production shutdown guarantee. Natural expiration before capture can still lose terminal changes that were never persisted.

## Durable Stop workflow

1. Authenticated DELETE checks project/session ownership and the three-per-minute Stop quota. A short transaction takes the command-account/project/session locks, creates one idempotent shutdown capture job and marks the registered session `stopping`. Sandbox quota is retained, and new commands/mutations are rejected. Shutdown does not invent a learner command audit.
2. The endpoint returns HTTP 202 with a shutdown receipt, not a false success. Post-response work attempts capture; the checked-in scheduler can resume a fenced lease after request/process loss once deployed. No database transaction spans a VM call.
3. The worker uses the original fixed VM session, closes command admission, terminates learner programs and persists the quiescence checkpoint. It captures all supported source, then runs the existing revision/conflict transaction. Any conflict preserves the whole changed batch, including newly created paths; it does not silently overwrite the canonical saved version.
4. Only a complete, terminal capture after quiescence authorizes VM Stop. Incomplete scans pause for explicit retry. Storage/provider failures retain the baseline and saved checkpoint; twelve failures or abandoned leases pause rather than looping forever. Retrying never reopens the closing VM or creates another one.
5. Lost Stop responses resume the saved checkpoint. Expiration after a confirmed save retains that receipt; expiration before it explicitly reports an incomplete final save. Stale leases cannot finalize another worker's claim.

The UI blocks Stop for an unsaved editor draft, confirms that running programs will stop, preserves the mounted source editor, and shows saving/retry/completion separately from ordinary expiration. A stopped project remains readable. Conflicting copies are chosen through Review source before restoring canonical source into a replacement. Explicitly confirmed project deletion remains a separate destructive workflow.

### Deferred immediate dispatch

The account-wide capture lease can defer a shutdown's first post-response claim. A live output/Stop check exposed a shutdown remaining in `stopping`; the old immediate dispatcher made only one attempt and the local server had no deployed cron to pick it up. Two new unit regressions reproduce the one-shot dispatch gap. The immediate dispatcher now checks only that job's bounded state metadata after an idle claim and retries brief contention, at most eight claims with 1–4 second backoff and a 45-second aggregate deadline. Finished, deleted, paused and distant-future jobs are not repeatedly polled. A current lease remains authoritative; the dispatcher cannot bypass it or reopen the VM. Longer delays and process loss still require the durable scheduler once deployed. This is not a substitute for deploying cron.

## Implemented VM boundary

Production terminal/AI command dispatch now initializes a root-owned `/var/lib/codetutor-runtime-v1` directory, then uses `gatedCommand()` before entering the existing unprivileged user/PID namespace supervisor. A read-only shared lock is inherited by that supervisor for its lifetime. Learner arguments remain separate argv entries, privileges remain dropped, and learner code never receives root execution.

`quiesceSandboxRuntime()` is the fixed, internal management operation needed before a final capture:

1. Persist a root-owned closing marker. Initialization and late command launches never clear or bypass it.
2. Use kernel process handles to terminate the learner's PID namespaces, including detached descendants and older guarded commands. Inspect the kernel UID in `/proc/.../status`, not `/proc` directory ownership: a non-dumpable process can make the latter appear root-owned.
3. Acquire the exclusive command-admission lock and the existing source-application lock. Pending launches/writes must leave those locks before quiescence is acknowledged. Process enumeration and lock waits are bounded.
4. Leave the marker in place. New source-application attempts reject with `SANDBOX_CLOSING` under their existing lock. Source reads, capture and revision acknowledgment remain possible.

Quiescence stops learner programs, **not** the VM. It neither commits captured source nor discards files. A timeout, unsafe control file, unsupported kernel facility or unconfirmed process termination leaves the marker closed and reports failure. It must never be interpreted as permission to destroy the sandbox. Previously committed source remains saved even if a delayed VM write is rejected; the API returns explicit saved-only recovery guidance.

The process selector is scoped to the workspace user's nested PID namespaces inside this owned VM; it does not signal host processes or root management commands. This relies on the existing application command boundary consistently using PID isolation. Arbitrary external commands started outside that boundary are not a supported shutdown guarantee.

## Verification

- `tests/runtime-gate.test.ts` executes the actual Python control/locking code against disposable local roots. It covers inherited locks, idempotent closure, delayed source rejection, held command/writer locks, unsafe modes/symlinks/hard links, failure persistence, argv isolation and redacted transport errors. Local tests replace the process signal function; they never signal unrelated local processes.
- `RUN_LIVE_SHUTDOWN_GUARD=1 node --env-file=.env.local node_modules/vitest/vitest.mjs run tests/live-sandbox-shutdown.test.ts` passes on a disposable real VM. It verifies a supervisor retains its lock after learner descriptors close, normal and `setsid` descendants terminate, an older non-dumpable namespace cannot hide, privilege restrictions remain, late commands/writes are rejected and terminal-edited source can still be captured. The VM is stopped in `finally`. This tests the management boundary directly, not the public Stop workflow.
- `node --env-file=.env.local scripts/verify-sandbox-shutdown.mjs` passes against the hosted database with disposable accounts and fake VM registrations. It covers cross-user/RLS/private-RPC denial, concurrent idempotency, command gating, pre-quiescence rollback, lease fencing, lost receipts, twelve-failure/crash pauses, explicit retry, incomplete scans, expiry and cascades. No real VM or AI request is made.
- The rebuilt local app's live source-worker flow passes: authenticated HTTP → hosted database → real command → conflicting-copy preservation → final-only source capture → Stop → owner review/acceptance → saved reads → replacement restore and execution. Its two temporary VMs and account are cleaned up. The initial test incorrectly expected a conflicted new file to be canonical immediately; the corrected check proves its exact bytes survive in durable review storage before the explicit owner decision. No AI request or email is used.
- After the deferred-dispatch repair, the complete `scripts/verify-live-sandbox.mjs` check passes using post-response dispatch without manually invoking the worker: commands, Unicode output/reconnects, final-source-preserving Stop, expiry and replacement restoration/execution. Runtime logs show queued jobs retried and acknowledged. Both disposable VMs and test accounts were cleaned up. The hosted shutdown protocol script also verifies that a preceding capture lease defers the first shutdown claim while keeping it queued. These checks do not establish cron deployment or recovery after host loss.
- Unit/component/route tests cover ordering, failed quiescence/storage/Stop, partial captures, stale leases, saved-checkpoint replay, unsaved-draft guards, duplicate clicks, account/project changes, stopped-versus-expired wording, progress retry and HTTP 202 behavior. Eight dispatch tests cover lease deferral, finite retry, terminal/deleted jobs, metadata failures, distant leases and a stalled worker deadline. Stopping aborts visible command-log subscriptions and error analysis without clearing existing source/logs.

## Remaining release verification

- Deploy the matching application and authenticated scheduler, then observe automatic recovery after process loss and sustained backlog under deployed time/capacity limits. Direct invocation of the production worker in the live test is not proof of deployed scheduling.
- Exercise pending command launches, in-flight editor/AI writes, quota/storage exhaustion, legacy sessions and expiration races through the full deployed workflow. Database/unit fixtures cover several failure states, not every provider race.
- Finish signed-in browser/keyboard/responsive verification of Stop, review, retry and restoration. No destructive override is implemented; never silently discard source to resolve a stuck capture.
- Complete source-journal bounds, full-archive import, deployed retention and the other SaaS release gates. The new inspectable full archive includes conflict copies and submission history but has no full-archive import yet. Source filtering is not proof that arbitrary source contains no secrets.

This implements and tests the shutdown protocol locally; it does not complete production deployment or the SaaS release gates.
