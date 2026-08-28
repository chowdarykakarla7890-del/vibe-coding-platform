# Practice lessons

The 18 curated Practice entries now contain specific behavior contracts, intentionally failing starter implementations, runnable visible checks, worked input/output examples, a concept explanation, three progressively specific hints, and two reflection questions. They replace generic scaffolding without changing activity IDs or ordering.

| Track | Fundamentals | Data flow | Composition |
| --- | --- | --- | --- |
| JavaScript | Delivery quote | Shopping-cart summary | Immutable task reducer |
| TypeScript | Support-ticket routing | Currency-specific payment totals | Unknown signup-payload validation |
| React | Accessible bounded counter | Controlled product filtering | Stale-safe asynchronous search |
| Python | ASCII URL slugs | Reimbursable expense grouping | Validated CSV roster import |
| Java | Museum-ticket pricing | Available inventory report | Reservation state machine |
| C++ | Score normalization and grades | Normalized tag counts | Bounded task-queue transitions |

## Workspace behavior

The **Instructions** dialog displays the entire contract, examples, optional concept/hints/reflection sections, and the selected variant's visible check command. It is keyboard accessible, scrollable, returns focus to its trigger when closed, and performs no network or sandbox mutation. Existing manifests without the optional `lesson` field still work. Instruction content also ships in `LESSON.md`; students write answers in `REFLECTION.md` and save before submitting.

Existing projects retain their saved source. Opening an old Practice project does not replace it with a new starter. Current catalog instructions may differ from older generic scaffolding; create a new activity project to start fresh, or adapt the existing source explicitly. Historical submissions retain the manifest stored with that attempt.

## Toolchains and commands

- JavaScript: `node --test lesson.test.mjs`, no package installation.
- TypeScript: the same behavioral command, using Node 24 type stripping. Run `npm install` and `npm run typecheck` separately for strict TypeScript checks. Node's [type stripping does not perform type checking](https://nodejs.org/api/typescript.html#type-stripping).
- React: `npm install`, then `npm test -- --run`. `npm run dev` serves the [Vite](https://vite.dev/guide/) workspace on port 3000 and `npm run build` produces a production build. Versions are pinned in each lesson package.
- Python: `python3 -m unittest -v test_lesson.py`, standard library only.
- Java/C++: `python3 check.py` compiles and then runs behavioral assertions. Compilation alone is not a passing check. Temporary build output is deleted by the runner. New, server-owned curated Java/C++ Practice sandboxes install their allowlisted compiler before attachment; an installation failure leaves no running workspace association and requests cleanup.

Runtime preparation never executes a model- or manifest-provided setup command. Unknown/generated activities cannot opt into privileged compiler preparation by naming a language. Restoration copies saved source and prepares the matching compiler again; React/TypeScript package dependencies still need installation because they are excluded from source snapshots.

## Assessment boundary

Practice checks are visible and editable. They are teaching aids, not an anti-tampering boundary, and earn no automatic server-trusted score. Submit uses the existing immutable-source, AI-assessed rubric path. The rubric covers behavior (60%), design (20%), preserved/added checks (10%) and reflection (10%). Correctness depends on the stated contract, not merely on process success. DSA's server-owned deterministic graders remain separate and unchanged.

The broader goal still needs deterministic Practice grading where appropriate, successful live AI assessment, signed-in browser launch/edit/submit flows, and deployment verification. This content checkpoint does not complete those gates.

## Verification

`tests/practice-catalog.test.ts` checks original IDs/order, schema limits, teaching artifacts, rubric totals and compiler eligibility. It materializes every starter in a temporary directory, verifies its checks fail with the intentional TODO error, replaces only the implementation with an independent test-only solution, and verifies the same checks pass. TypeScript solutions additionally pass strict compilation; React solutions build. Temporary test files are removed, and reference solutions are never imported into the learner bundle.

`tests/activity-instructions.test.tsx` covers full instructions, collapsed hints, focus return, old manifests and selected-variant commands. `tests/practice-runtime.test.ts` and the sandbox lifecycle tests cover allowlisted compiler commands, cancellation, setup-before-attachment, and cleanup on failure.

`tests/live-practice.test.ts` is opt-in via `RUN_LIVE_PRACTICE=1`. It uses one disposable Linux VM, installs the pinned React dependencies, runs all 18 starter/solution pairs, builds all three React solutions, and stops the VM in `finally`, including recovery by its unique name after a lost creation receipt. It creates no accounts and sends no AI request. This is toolchain verification, not proof of browser/API/assessment integration.

The 2026-08-28 live matrix passed in 85 seconds, including confirmed VM cleanup. The full default suite passed 1,403 tests (12 opt-in tests skipped); lint, TypeScript, the Node 24 production build and the production dependency audit also passed. No database migration, deployment, credential rotation or customer-data change was part of this checkpoint.
