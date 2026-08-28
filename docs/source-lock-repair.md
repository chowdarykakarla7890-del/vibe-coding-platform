# Concurrent source-lock initialization repair

## Confirmed failure

The isolated ten-writer diagnostic reproduced `ENOENT` at the descriptor-relative
`os.open('apply.lock', O_RDWR | O_CREAT | O_NOFOLLOW, ...)` operation. This happened
before lock acquisition or source writes. It was not sufficient to dismiss the
failure as test-runner load or a full disk. No production incident is attributed
to this race without corresponding runtime evidence.

## Repair boundaries

- All five source operations (apply, capture, acknowledge, conflict resolution,
  and shutdown) use the same lock-opening helper.
- Only `FileNotFoundError` on lock initialization is retried, at most three opens
  with at most two 20 ms sleeps, bounded further by the caller's deadline.
- Apply, capture, and acknowledge share their existing five-second budget with
  lock acquisition. Shutdown retains its seven-second budget. Conflict resolution
  still attempts `flock` immediately rather than waiting on another writer.
- Lock files remain descriptor-relative and no-follow, are never unlinked or
  replaced, and must be private, regular, singly linked, and trusted-owner files.
  Nonblocking open also avoids hanging on an unexpected FIFO.
- Permission, I/O, and disk-full failures are not retried or represented as success.
  Revision fencing, write-ahead journals, terminal-edit preservation, and the
  shutdown closing marker remain intact.

## Reproduction and regression checks

Run `node scripts/check-source-concurrency.mjs` for eight isolated rounds of ten
writers. `SOURCE_CONCURRENCY_ROUNDS` accepts 1–40 rounds, and
`CODETUTOR_TEST_PYTHON` can select a Python executable. The check executes the exact
embedded program using tiny temporary fixtures, waits for every child before
cleanup, and verifies revision 10 wins each round. It uses no sandbox or credential.
CI runs it after the unit suite.

`tests/sandbox-source-lock.test.ts` covers injected transient/persistent `ENOENT`,
shared lock use, unchanged inode, deadlines, nonretryable OS failures, unsafe
files, and descriptor cleanup. Existing source and runtime tests retain their
real filesystem locking and revision assertions.

This repair belongs to the SaaS validation branch. It does not provision hosted
resources, apply hosted migrations, or deploy the SaaS branch over the separate
local-first production hotfix.
