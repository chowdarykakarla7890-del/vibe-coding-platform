# Command output transport

The command-status route is bounded to 10 seconds. The log route reads for at most 20 seconds (including its initial lookup), emits at most 64 KB of NDJSON per window, and explicitly closes/aborts the SDK log reader. Neither endpoint waits indefinitely for process completion.

Live SDK 3.1.0 checks found that `getCommand()` can continue returning `exitCode: null` after all logs ended, until the wait endpoint is consulted. `readCommandExitCode()` probes `command.wait()` for at most one second, inside the route's overall deadline, and aborts the probe afterward. An unfinished/background command returns `running`. The log endpoint probes only after draining output. This bounded probe replaces the earlier incorrect assumption that `getCommand()` alone always publishes completed exit codes; it does not restore the former unbounded wait.

## Checkpoints

`cursor=v3.<stdout-bytes>.<stderr-bytes>` records independently consumed UTF-8 bytes. The initial value is `v3.0.0`; omitted cursors and legacy `-1` also start from zero. The response advertises `X-Log-Cursor-Version: 3`. Old nonnegative numeric cursors are rejected rather than silently skipping or repeating output; clients using the old protocol must reload.

SDK chunks and stdout/stderr interleaving are not stable event IDs. A replay may regroup chunks or interleave the streams differently. The server skips each stream's acknowledged prefix, splits large entries without splitting UTF-8 characters, and advances the cursor only for delivered data. A size-limited window never acknowledges its omitted suffix.

Records are `log`, `status` (`running`, `done`, `expired`), or a redacted `error`. `done` means both the output is drained and the command has an exit code. Process completion alone must not cancel the client's remaining output read.

## Client ownership and limits

One layout-level subscriber owns each visible `{sandboxId, cmdId}`. Up to three log readers run concurrently. Account-bound requests abort on sign-out/account change. Switching sandbox, unmounting, expiration, or completion cancels obsolete readers. The Zustand command retains its cursor across subscriber remounts and drops duplicate records.

Transient failures get three exponential-backoff retries; terminal errors do not automatically retry. Exhaustion displays `Retry output` without incorrectly marking a still-running process as failed. Rendered output retains at most 256 KB/512 records per command, with an explicit omission notice. This bounds browser memory; it does not delete the sandbox's logs.

## Required dependency patch

`@vercel/sandbox@3.1.0` uses `jsonlines@0.1.1`. Its parser called `Buffer.toString()` separately for every network chunk. A multibyte character split between chunks became replacement characters, changing decoded byte counts between replays and invalidating even per-stream cursors.

`patches/jsonlines@0.1.1.patch` uses Node's incremental `StringDecoder`, registered in `pnpm-workspace.yaml` and the lockfile so clean installs and Vercel builds receive the same fix. `tests/sandbox-log-decoding.test.ts` loads the SDK's actual transitive parser. The 1-, 2-, and 7-byte fragmentation cases failed before the patch. Remove the patch only after an upstream fix is installed and these tests still pass.

### Byte-safe command transport

The incremental parser repair fixes HTTP fragmentation, but cannot repair Unicode already corrupted by the upstream service. The raw SDK diagnostic still reproduces that defect: 25,000 copies of `🙂\n` become 125,008 bytes with four replacement characters instead of 125,000 bytes.

New commands use `encodedCommand()`. A fixed Python encoder runs **inside** the existing unprivileged PID namespace. It reads at most 3,072 raw pipe bytes at a time and writes ASCII frames, `CT1:<sequence>:<base64>`, before the Sandbox text service sees the data. Stdout and stderr have separate sequences; `.` terminates a stream. No command arguments or output are added to the application database, and no output files or dependencies are introduced. The encoder preserves argv, working directory, exit code and the existing process-tree Stop/timeout guard.

`readCommandLogs()` reconstructs frames across arbitrarily regrouped SDK chunks, validates sequence and canonical base64, and incrementally decodes UTF-8 separately for each stream. It preserves BOMs and characters split across raw reads. Partial, oversized or malformed frames produce a redacted retryable error, never a fallback that mistakes framing for user text. Complete frames remain readable after abrupt termination even without a final marker. It retains at most one bounded partial frame and decoder state per stream. Binary/invalid UTF-8 is displayed using normal replacement-character decoding; this is a text terminal, not a binary-download interface.

Decoding occurs before the 64 KiB AI-output cap and before v3 cursor/window accounting. The public NDJSON protocol, text cursor semantics and client subscriber are unchanged. `command_audits.output_encoding` identifies `raw` versus `base64-v1`; the server-only `attach_encoded_command` function atomically attaches the new format and command ID. Existing commands and the original attachment RPC remain raw. Format selection never depends on sniffing output or a browser-supplied flag. Historical raw logs can retain upstream corruption; this repair cannot reconstruct already lost bytes.

Verification on 2026-08-27:

- Four fragmentation tests (1, 2, 7 and 8,192 characters) preserve mixed-language UTF-8, interleaved stderr and BOMs. Invalid frames, missing/reordered sequences, oversized buffers, cancellation, historical raw text and abrupt completion are covered. A local test executes the actual Python encoder, including argv preservation and exit code 3.
- A route test replays changing SDK chunk boundaries across bounded log windows and checks exact decoded-byte cursors. AI/verification output tests check the decoded 64 KiB cap.
- `RUN_LIVE_COMMAND_OUTPUT=1 node --env-file=.env.local node_modules/vitest/vitest.mjs run tests/live-command-output.test.ts` passes with one disposable VM: 450,000 bytes of mixed-language stdout, Unicode stderr, two identical replays, nonzero exit, Stop and process timeout. The VM is stopped in cleanup.
- The rebuilt application delivered the original 125,000-byte regression exactly across three log windows and passed the 20-second idle reconnection, command ownership, quota and privilege checks. The first full run subsequently exposed a separate deferred shutdown scheduling failure. After bounded dispatch retry was added, the complete live script passed through final source preservation, Stop, expiry, replacement restoration and exact Unicode output again. Both disposable VMs and accounts were cleaned up. This uses the local application and real hosted services, not a deployed production app or signed-in browser.
- Hosted migration `20260827134435_command_output_encoding.sql` is applied. The real two-user HTTP/database suite verifies denied browser writes/RPCs, cross-owner denial, raw/new format attachment, and refusal to change an already attached format.

`node --env-file=.env.local scripts/diagnose-sandbox-stream.mjs` remains a deliberately raw upstream diagnostic. It prints synthetic counts/status only, cleans up, and fails while the upstream service corrupts Unicode. It is not the encoded application test. The application live script now defaults to large Unicode; set `TEST_LARGE_UNICODE=0` for the separate ASCII case. These repairs are local and not deployed.

`node --env-file=.env.local scripts/verify-live-sandbox.mjs` is an opt-in paid-resource test against the local application. It creates temporary users/project/VMs, verifies ownership, durable source, large output, reconnects, bounded status, command failure, expiration and replacement-source restoration, then stops/deletes only its temporary resources. No AI calls or emails are sent.

## Command execution and Stop

Terminal, AI-tool and verification starts use the same authenticated command service. A private database reservation is taken before dispatch, with an atomic per-user cap of three active commands across projects and 30 starts per rolling minute. Status, logs and Stop require both the owned sandbox and its owned command audit record. Audits record IDs, executable category, timing and outcome, not arguments or output. An uncertain dispatch keeps its slot until completion or sandbox expiration is confirmed; an HTTP timeout is not proof that a process stopped.

The terminal defaults to a 60-second process deadline. Its explicit **Server** mode permits a background server up to the remaining sandbox lifetime (maximum 45 minutes). **Stop** invokes the owned command DELETE endpoint and reports success only after command termination is confirmed. A failed/uncertain Stop remains retryable. Output draining continues after Stop so trailing output is not lost. Browser requests are aborted on unmount or sandbox/account changes.

### Process-tree regression

The SDK's `kill('SIGKILL')` terminates its direct command, not arbitrary children. A live test killed a shell while its `sleep` child remained alive, making `wait()` time out and leaving output open. `guardedCommand()` now runs a fixed `/usr/bin/unshare` launcher with user/PID namespaces and `--kill-child=KILL`. Killing or timing out this parent causes the kernel to terminate the namespace's process tree, including descendants that called `setsid`. The existing UID/GID is mapped unchanged; `setpriv` drops effective/inheritable/ambient/bounding privileges and sets `no_new_privs` before executing learner code. All options are fixed argv entries; neither model-controlled sudo nor a root shell is used.

The existing `/proc` mount is intentionally retained because the hosted runtime denies an unprivileged remount. Host-style PID information may therefore be visible within this already project-owned VM; kernel namespace membership, not hidden PID listings, controls signals. See the primary [`unshare` documentation](https://man7.org/linux/man-pages/man1/unshare.1.html) and [PID namespace lifecycle](https://man7.org/linux/man-pages/man7/pid_namespaces.7.html).

Production dispatch additionally uses `gatedCommand()` beneath `encodedCommand()`: a fixed isolated Python preflight takes a read-only admission lock before becoming the same `unshare` supervisor. This provides a VM-side fence for safe shutdown. Root-only initialization cannot reopen a closing gate, and initialization failure cancels the reserved command before learner dispatch. The quiescence operation does not itself stop the VM; the durable shutdown worker saves source before Stop. Deployment and scheduler verification remain required. See [sandbox shutdown](./sandbox-shutdown.md).

`scripts/diagnose-sandbox-stop.mjs` verifies normal and detached-session child cleanup on both Stop and SDK timeout in a disposable VM. It also checks unprivileged execution, zero capabilities, writable workspace and Node/npm availability. The `REPRODUCE_UNGUARDED=1` variant reproduces the original leak and always stops its diagnostic VM in cleanup.

### Non-idempotent dispatch

`patches/@vercel__sandbox@3.1.0.patch` disables automatic retries only for command-creation POSTs. Retrying after a lost response can otherwise launch the same paid command twice despite a single database reservation. Tests exercise the actual installed ESM and CommonJS retry wrappers for 429/500/503/network failures and confirm safe GET retry behavior remains unchanged. Keep this patch until an upstream idempotency guarantee replaces it.
