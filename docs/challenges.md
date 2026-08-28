# Challenge contracts and grading

Implemented in the unfinished SaaS worktree; not deployed. The original 18 Challenge IDs and ordering are preserved. There are **three code contracts in five language tracks** (15 entries), plus three distinct React interaction challenges. These are not 18 unrelated algorithms.

## Catalog

| Track / suffix | Contract | Assessment |
| --- | --- | --- |
| JavaScript, TypeScript, Python, Java, C++ / `transform` | Compact zero readings: retain every nonzero value in its original order and append zeros to preserve length. Includes duplicates, negatives, empty input and 200-item boundaries. | 24 server-owned checks |
| Same five tracks / `validator` | Validate canonical IPv4 text: four decimal octets, each 0–255, no signs, whitespace, leading zeros, trailing junk or missing segments. Input is bounded printable ASCII; this is not a general network-address parser. | 24 server-owned checks |
| Same five tracks / `performance` | Count nonempty contiguous target-sum windows, including overlaps, zeroes and negative values, for up to 10,000 integers. Prefix-frequency counting is taught; tests do not prove asymptotic complexity. | 24 server-owned checks |
| React / `transform` | Derive an ordered basket summary and exact total from immutable item props; handle zero quantities, empty baskets and new props. | AI assessed; editable interaction checks |
| React / `validator` | Accessible username form with exact validation, associated error text, focus handling, edit recovery and single successful submission. | AI assessed; editable interaction checks |
| React / `performance` | Keep an expensive derived report stable during unrelated state updates, while recomputing for either changed input or changed calculation function. | AI assessed; editable interaction checks |

Each entry has a precise signature, failing TODO starter, examples, concept explanation, progressive hints, reflection prompts and a `LESSON.md`. React entries also have pinned dependency manifests and runnable Vitest/Testing Library checks. Instructions are available from the existing activity header; no new navigation or model-selection behavior is introduced.

## Trusted code submissions

Only an exact curated Challenge ID and matching language selects a trusted grader. Generated activities, mismatched languages, client-supplied manifests and learner test scripts cannot grant execution authority. Trusted failures never fall back to an AI score.

The API freezes authoritative saved source first, then uses the same authenticated, owned-sandbox protocol as DSA. Only the documented entry file and fixed harness execute, with a fresh isolated process for each case. Expected answers remain on the application server. The immutable private plan stores all 24 inputs, source and harness fingerprints, the runner fingerprint and `challenges-v1`. Results must be retained before the database accepts an assessment; score is `floor(100 × passed / 24)` and completion requires all 24 checks. Reflection is encouraged but is not part of this automatic score.

Each contract has 12 fixed boundary cases and 12 randomized cases. Compiled-language harnesses use the existing length-prefixed codec; JS/TS/Python receive the documented object/dictionary. TypeScript grading uses Node type stripping, not a type-checking score. React checks remain editable teaching aids and do not establish a server-trusted result.

The performance plan includes three 10,000-item inputs. A real Linux run exposed the old 8 KiB per-input ceiling. Inputs are now validated at 64 KiB UTF-8 each, at most 24 cases, while the entire payload stays capped at 2 MiB and the private plan at 128 KiB. Input validation happens before runtime setup. Nonblocking stdin writes share the selector loop with stdout/stderr reads, so code that never reads or writes before reading cannot bypass the 1.5-second case deadline or 2 KiB combined-output limit. Compilation and outer command bounds remain unchanged.

Five regression cases failed before this repair. The seven I/O checks cover admission limits and invalid Unicode, blocked input, full duplex pipes, exact Unicode delivery, early stdin closure, output flooding, malformed output and closed-output processes. macOS transport tests deliberately force backpressure using a larger internal fixture; that does not relax the public 64 KiB admission limit.

## Verification

- Default tests validate all 18 manifests and starters, compare randomized/boundary cases against independent implementations, reject plausible shortcuts and forged score objects, compile every language signature, and run React starter/solution interaction checks and production builds.
- Route tests verify all 15 trusted registrations, correct quota selection and no AI fallback. Lifecycle tests verify fresh compiler/runtime preparation before attachment, with failure cleanup and rejection of generated/mismatched identities.
- `tests/live-challenges.test.ts` checks all 15 code entries and three React projects on one disposable Linux VM. It also checks maximum-sized blocked stdin, output flooding, oversized input rejection, artifact removal and absence of remaining grading processes. `finally` stops the VM, including lookup by its unique name after a lost creation receipt.
- The existing DSA foundation matrix is rerun because the input/output supervisor is shared.
- `tests/live-dsa-submission.test.ts` has a separate Challenge opt-in. It runs the 10,000-item contract through the rebuilt local HTTP app, hosted Supabase and an owned VM using two disposable users. It checks ownership, CSRF, forged scores, authoritative source despite VM-only changes, retained summaries, cancellation, expiry, immutable source, checksum-verified archives and zero AI quota consumption. Temporary users are signed out before deletion; all test VMs are stopped.

```sh
RUN_LIVE_CHALLENGES=1 node --env-file=.env.local node_modules/vitest/vitest.mjs run tests/live-challenges.test.ts --maxWorkers=1
RUN_LIVE_DSA_GRADER=1 node --env-file=.env.local node_modules/vitest/vitest.mjs run tests/live-dsa-grader.test.ts --maxWorkers=1
TEST_APP_URL=http://127.0.0.1:3112 RUN_LIVE_CHALLENGE_SUBMISSION=1 node --env-file=.env.local node_modules/vitest/vitest.mjs run tests/live-dsa-submission.test.ts --maxWorkers=1
```

The default 2026-08-28 suite passes 1,520 tests (15 live opt-ins skipped), with lint, TypeScript, the Node 24 production build and no known production dependency vulnerabilities. The authenticated Challenge HTTP/database/VM test passed in 43 seconds, including cleanup. The complete 18-entry Challenge matrix and the DSA foundation/isolation regression suite both passed in a combined 230 seconds, including all three React production builds, payload/process cleanup and confirmed VM stops. These local and disposable-infrastructure checks are not proof of deployed behavior.

## Remaining release work

The six [Project blueprints](./project-blueprints.md) now have substantive staged content and editable checks; Project submissions remain AI assessed. Practice/Debug trusted evaluation where appropriate, successful funded AI assessment for rubric-only activities, signed-in browser/axe checks, isolated Preview migration replay, deployed workers/monitoring, OAuth/email verification, exposed-credential rotation and production promotion remain open. Exact historic VM/compiler replay is not implemented. No database migration or release is implied by this catalog work. See [the SaaS release gates](./saas-release-gates.md) and [grading evidence](./grading-evidence.md).

References: [Python nonblocking descriptors](https://docs.python.org/3/library/os.html#os.set_blocking), [selector readiness](https://docs.python.org/3/library/selectors.html), [Vercel Sandbox](https://vercel.com/docs/sandbox).
