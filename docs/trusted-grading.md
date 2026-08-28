# Trusted grading: DSA and code Challenges

Implemented in the unfinished authenticated SaaS worktree, not deployed. All **15 DSA activities** have real contracts, deliberately incomplete starters and server-controlled behavioral checks. The **15 code-Challenge entries** (three contracts in five language tracks) now use this protocol too; see [Challenge contracts and verification](./challenges.md). The [18 Practice lessons](./practice-lessons.md), [12 Debug exercises](./debug-lessons.md) and three React Challenges have tested teaching content but remain AI-assessed. The six [Project blueprints](./project-blueprints.md) now have concrete staged workflows and tested teaching checks, and also remain AI assessed. The catalog extensions reuse existing submission/command infrastructure; the [durable grading-evidence checkpoint](./grading-evidence.md) adds private retained checks, outcomes and database-enforced score matching. Verification below separates these checkpoints.

## Scope and contracts

| Curated ID | Required result |
| --- | --- |
| `dsa-python-two-sum` | Any pair of distinct zero-based indices adding to the target, or `[]` when no pair exists |
| `dsa-python-valid-parentheses` | Boolean indicating correctly matched/nested `()[]{}`; the empty string is valid |
| `dsa-python-binary-search` | First matching zero-based index in a sorted array, or `-1`; duplicates are allowed |
| `dsa-python-merge-intervals` | Sorted disjoint closed intervals, merging overlap and touching endpoints |
| `dsa-python-longest-substring` | Length of the longest contiguous substring without repeated characters |
| `dsa-python-tree-level-order` | Level arrays from compact breadth-first serialization; null parents consume no child slots |
| `dsa-python-number-islands` | Count four-neighbor land components; diagonal contact is not connected |
| `dsa-python-coin-change` | Minimum reusable coins for the amount, `0` for zero amount, `-1` if impossible |
| `dsa-python-top-k` | Distinct values by descending frequency, ties by ascending value; clamp k to available values |
| `dsa-python-linked-cycle` | Whether following next indices from head reaches a cycle; unreachable cycles do not count |
| `dsa-python-word-break` | Whether the entire text can be split into reusable dictionary words; empty text is true |
| `dsa-python-course-schedule` | Whether all prerequisite constraints can be satisfied; duplicates are one constraint |
| `dsa-python-lru-cache` | Get results under exact least-recently-used eviction, including capacity zero |
| `dsa-python-median-stream` | Median after each insertion; preserve fractional halves |
| `dsa-python-edit-distance` | Minimum insertions, deletions and substitutions; transposition is not a single edit |

The IDs retain their existing `python` prefix and catalog order for compatibility. All 15 have JavaScript, TypeScript, Python, Java and C++ variants with precise instructions, examples and deliberately failing TODO starters. The selected starter defines the exact function signature and result type.

| Language | Saved entry | Function |
| --- | --- | --- |
| JavaScript | `src/main.mjs` | Export `solve(value)` |
| TypeScript | `src/main.ts` | Export the typed `solve(value)` from the starter |
| Python | `src/main.py` | `solve(value)` |
| Java | `Main.java` | Static `Main.solve(...)` with typed named arguments |
| C++ | `src/main.cpp` | `solve(...)` with typed named arguments |

JS/TS/Python receive the documented input object/dictionary (a raw string for Valid Parentheses). Java/C++ signatures and return types are specified in their starter. The fixed compiled-language harness uses a length-prefixed line codec, preserving empty strings, empty rows and nullable tree slots; learners do not implement input parsing. Each task documents its own bounds in `lib/learning/dsa-foundations.ts` or `lib/learning/dsa-extended.ts`. TypeScript uses Node's supported type stripping, not a full type-checking grade. Correctness scores do not prove asymptotic complexity or enforce a particular algorithm.

## Submission and scoring

1. Authenticate the account; authorize the project, activity and sandbox registration. Reject forged manifest/source/score fields, unsupported models and mismatched variants.
2. Consume bounded assessment quotas and freeze the authoritative saved source through the existing submission transaction. Unsaved drafts are not submitted.
3. Select the fixed server grader by exact curated ID and language, not by a learner-provided command or generated manifest. Require a live owned sandbox prepared before learner access.
4. Retain the exact 24 input cases (12 explicit boundaries and 12 randomized cases), check version and source/harness/runner fingerprints privately before execution. Reserve report storage, then stage only the frozen entry, fixed harness and cases. Verify the serialized payload's SHA-256 before execution. Learner-owned package scripts and test files are never used to score.
5. Run the isolated program; expected answers and scoring logic remain on the application server. Parse bounded result values strictly and compute `floor(100 × passed / 24)`. Only 24/24 passes marks completion. Compile/runtime test failures score zero or partial credit; infrastructure failure, cancellation, expiry or incomplete evidence retains an unscored attempt.
6. Persist the bounded private per-case report before saving one authoritative assessment receipt (`verification_kind: command`, `ai_assessed: false`). A database trigger rejects trusted scores that do not match retained outcomes. The source-revision comparison controls whether the current project can be marked complete; old submitted files remain immutable.

The endpoint/model interfaces are unchanged. Other activities remain AI assessed. Trusted grading never uses AI credits or silently falls back to a provider. It consumes assessment limits (10/minute, 200/day), the existing 30 command starts/minute and three active-command account limit, plus Sandbox resources.

## Execution boundaries

- Only fixed server-authored management programs run privileged. Payload paths/digests are validated; client or model PIDs/program text are never accepted as stop authority.
- Each case has fresh mount, network and PID namespaces, a restricted filesystem root, no-new-privileges, dropped capabilities and UID/GID 65534. System mounts are read-only; submitted source/harness are root-owned and nonwritable. Build output alone is writable. No external network is available.
- The current upstream image is Ubuntu 26.04. Java/C++ toolchains are installed with fixed package arguments only during fresh sandbox creation. The image's learner-writable Node binary is copied to a root-owned location before the sandbox is associated with a project; a used sandbox is never retroactively trusted by copying its executable.
- Old or missing toolchains yield `409 GRADING_ENVIRONMENT_OUTDATED` with save/stop/restore guidance. A running workspace command can yield `409 GRADING_WORKSPACE_BUSY`. Neither creates a fabricated score.
- Each case has 1.5 seconds and 2 KiB of combined output; compilation has 10 seconds/8 KiB. The case output limit was increased from 256 bytes so valid matrix and sequence answers fit. The outer owned command remains configured for 60 seconds and 64 KiB output capture; aggregate truncation yields no score. File size, open-file, process-count and CPU rlimits apply. Node/Java heaps are capped at 64 MiB; this is **not a hard total-memory cap**. VM-level resource limits are separate.
- Inputs are validated at 64 KiB UTF-8 per case and 24 cases, with the existing 2 MiB payload limit. The earlier 8 KiB input limit rejected valid 10,000-item Challenge cases. Input writes now use nonblocking readiness alongside output reads; blocked stdin cannot bypass the deadline or output cap. Seven local I/O regressions and real-VM blocked-input/output-limit/oversize cases pass. The DSA foundation matrix and isolation checks were rerun after this shared supervisor change.

## Cancellation and status races

Live testing found that the SDK acknowledged killing its unprivileged launch wrapper without terminating the privileged grading supervisor. Relying on that acknowledgment left the audit `unknown` and its slot reserved.

The fixed supervisor atomically registers its PID and Linux start time in a root-owned, mode-0600 record under a mode-0700 directory. The trusted stop program opens a Linux pidfd, verifies the recorded start time and root identity, signals that exact process and waits for its exit notification before deleting private artifacts. Killing the supervisor destroys its grading PID namespace and descendants. The application still waits for SDK-confirmed command completion before reporting Stop; it retries a lost custom cleanup receipt rather than treating process exit as proof of deletion. Unconfirmed cleanup remains retryable, rather than claiming success.

The background capture worker can observe process termination before the cancellation request saves its audit result. The first terminal database transition is immutable: it may be `cancelled` or `done` with a nonzero exit code. `done` means the process ended, not that the learner passed. The corresponding interrupted submission remains failed and unscored.

Normal completion and application Stop now remove the staged payload, private per-run scratch tree and process record. The cancellation leak was reproduced and repaired. Closed markers fence delayed launches, and bounded passes on subsequent grading launches reclaim externally killed jobs and late uploads. Cleanup validates ownership and never follows a scratch symlink into student source. Old unregistered scratch directories are not swept; orphan recovery still requires a later grading request or VM expiration. See [cleanup protocol, tests and limits](./grading-cleanup.md). The live tests stop every disposable VM in `finally`. A lost remote stop acknowledgment is not confirmation that a VM has stopped.

## Verification

Run only with the configured ignored local environment. The HTTP suite refuses nonlocal app hosts. These opt-ins incur Sandbox usage, create no AI calls or customer data, and clean up temporary resources:

```sh
RUN_LIVE_DSA_GRADER=1 node --env-file=.env.local node_modules/vitest/vitest.mjs run tests/live-dsa-grader.test.ts
RUN_LIVE_DSA_CATALOG=1 node --env-file=.env.local node_modules/vitest/vitest.mjs run tests/live-dsa-catalog.test.ts --maxWorkers=1
RUN_LIVE_DSA_CANCELLATION=1 node --env-file=.env.local node_modules/vitest/vitest.mjs run tests/live-grading-cancellation.test.ts
TEST_APP_URL=http://localhost:3112 RUN_LIVE_DSA_SUBMISSION=1 node --env-file=.env.local node_modules/vitest/vitest.mjs run tests/live-dsa-submission.test.ts
```

Previous foundational live checkpoint:

- All 15 combinations of the first three activities and five languages, each with 24 host-checked cases; normal record/payload cleanup; altered learner Node ignored; read-only source, filesystem/network isolation, payload tampering, forged scores, output flooding and daemon cleanup.
- Actual running learner processes stopped, no remaining grading UID processes, private process records inaccessible through the application's privilege-dropped command boundary, and a stale start-time record unable to kill an unrelated disposable process. Raw SDK management commands are not the learner boundary.
- Cookie-authenticated HTTP → hosted Supabase → owned VM: correct and incorrect grades, authoritative saved source despite VM-only edits, cross-user/anonymous/CSRF rejection, immutable history, interrupted and expired attempts without scores, confirmed command completion and no AI quota use.
- Default suite: 940 tests pass, nine opt-in suites skipped. Focused tests cover failure mapping, output validation, cancellation, privileged-path rejection and accurate UI assessment labels. Lint, TypeScript, the Node 24 production build and whitespace checks pass; the production dependency audit reports no known vulnerabilities.

Catalog-extension verification:

- The twelve new tasks use check version `dsa-catalog-v2`, twelve fixed boundary/example cases and twelve randomized cases per submission. Host-only oracles never enter the learner VM.
- Unit tests compare 5,760 boundary/generated inputs with independent JavaScript implementations, validate bounds, reject twelve plausible wrong answers, preserve input values, and ensure valid answers fit the output limit. All 75 activity/language variants have schema-valid failing starters and registered graders.
- Route and lifecycle tests cover all 75 variants: the request chooses trusted grading without AI credits and fresh runtime preparation precedes attachment to a learner project.
- The opt-in catalog test passed all 60 new problem/language combinations in one disposable VM, using actual compilers and 24-case solutions plus one failing TODO starter case per variant. All staged payloads were removed and sandbox shutdown completed. The run took 306 seconds, made no AI requests and created no customer data. It is not an authenticated browser/HTTP test.
- The foundational real-VM suite was rerun against this same implementation and passed in 91 seconds: all original 15 combinations plus private runtime/source, filesystem/network isolation, payload tampering, forged scores, output flooding and runaway-process cleanup. Its disposable VM also stopped successfully. Together these two runs verify all 75 DSA combinations; they do not replace the remaining browser/deployment gates.
- The full local suite passes 1,257 tests (11 opt-in tests skipped by default), lint, TypeScript, the Node 24 production build and whitespace checks. The production dependency audit reports no known vulnerabilities. HTTP smoke checks pass against the rebuilt local app; the isolated helper could not start because its fixed port was occupied, and that existing process was not stopped.

The later evidence checkpoint passed hosted SQL validation/ownership/quota checks and a rebuilt local HTTP → hosted database → real VM flow. Submission history and full archives retain safe check-by-check summaries after the VM expires; hidden inputs and output stay private. See [exact evidence and verification](./grading-evidence.md).

Still required: live Project rubric verification, deterministic Practice/Debug grading and live rubric verification, signed-in browser/axe checks, isolated Preview and deployment verification, resource/load testing, deployed cleanup monitoring and complete live AI checks once funded. Exact randomized inputs and observed outputs are now retained, but byte-identical historic runtime replay is not implemented: compiler/VM images and executable old grader versions are not archived. This is not a claim of a complete production-grade judging system.
