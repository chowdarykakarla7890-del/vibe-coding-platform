# Project blueprints

Implemented in the unfinished SaaS worktree, not deployed. All six original Project IDs, titles and ordering are preserved. The old generic `solve(3)` scaffolds are replaced by six concrete projects, each with four staged milestones, a precise domain contract, examples, visible checks, hints and reflection prompts.

| Track | Project | Workflow and checks |
| --- | --- | --- |
| JavaScript | Personal finance tracker | Integer-cent ledger, immutable edits, composed filters, derived totals, strict versioned JSON, DOM add/delete/filter and storage-failure handling. Educational accounting only, not banking software. |
| TypeScript | Typed issue board | Runtime validation alongside static types, legal workflow transitions, priority-sorted views, global counts, browser persistence and failed-save recovery. |
| React | Accessible habit coach | Loading/error/retry states, validated habits, daily completion history, labeled controls, save-before-publish edits, retained failed drafts and stale-operation cancellation. |
| Python | Study planner CLI | Validated dates and tasks, deterministic whole-task scheduling, strict JSON restoration, real CLI processes and same-directory atomic file replacement. |
| Java | Library lending service | Book/member registration, one loan per book, three loans per member, exact overdue boundaries, returns, immutable reports and per-instance isolation. An in-memory domain service, not an HTTP server. |
| C++ | Terminal task engine | Immutable task operations, priority/ID ordering, strict versioned TSV, atomic file replacement and persisted add/list/next/done CLI behavior. |

## Milestones and assessment

The activity header's **Instructions** dialog shows all four milestone goals, acceptance criteria and terminal check commands. Opening it never starts a VM or executes code. `MILESTONES.md` holds the learner's checklist and evidence; checked boxes do **not** award verified progress or a score. `REFLECTION.md` captures design and failure-recovery decisions. Source saves retain those files through the existing project history.

Project submissions are explicitly **AI assessed**. Editable test files are learning aids, not server-owned grading evidence. The existing submission path freezes saved files, revisions and the manifest before assessment. It retains the full submission, rejects missing source and rejects AI evidence above 64,000 UTF-8 bytes rather than silently assessing a prefix. These blueprints do not add deterministic Project scoring or automatic milestone completion.

Optional, bounded `milestones` metadata is backward-compatible with manifests that lack it. Duplicate milestone IDs and malformed/oversized fields are rejected. Existing saved projects are never overwritten by catalog updates: create a new Project to receive the new starter, or adapt older source explicitly. Historical submissions retain their original instructions.

## Runtime preparation

Fresh curated Java/C++ Project sandboxes receive compiler preparation only after an exact catalog ID and persisted-language match. Setup uses fixed server-owned arguments before attachment, never a model-generated command. Failure cleanup and mismatch rejection use the existing lifecycle safeguards. Preparation also applies when restoring a Project into a fresh sandbox.

Browser projects include pinned Vite/test dependencies. Run `npm install`, then the displayed checks; TypeScript also requires `npm run typecheck`. `npm run dev` serves port 3000 and `npm run build` builds the web bundle. Dependencies are not included in source snapshots and must be reinstalled after restoration. CLI/service projects use terminal output, not an HTTP preview.

The sample persistence adapters are deliberately single-user educational designs. Atomic replacement protects against partially written files but does not coordinate concurrent writers. The habit and finance adapters are device-local examples, not the SaaS application's authenticated cloud persistence.

## Verification

- `tests/project-catalog.test.ts` validates all six manifests, preserved IDs, bounded milestone schemas, assessment labels, compiler eligibility and reflection files. Each unfinished starter must fail on its TODO, not missing tooling. Test-only reference implementations replace only implementation files, then pass the same four milestone commands and full workflow. Java/C++ runners reject unknown milestone names. Both TypeScript starter and reference are type-checked, and all three web projects build.
- `tests/activity-instructions.test.tsx` checks every milestone's accessible display and focus return, no automatic execution controls, and explicit AI-assessment/self-reported-progress labeling.
- `tests/sandbox-lifecycle.test.ts` verifies curated Project compiler preparation before attachment, cleanup on setup failure, and rejection of generated, unknown or language-mismatched IDs.
- `tests/live-projects.test.ts` repeats the complete six-project matrix on one disposable Linux VM with pinned dependencies, real Java/C++ compilers and per-command deadlines. The unique test-only VM is stopped in `finally`, including lookup after a lost creation receipt. No customer source, AI calls, account creation or deployment is involved.

```sh
CODETUTOR_TEST_PYTHON=/path/to/python3.11-or-newer pnpm exec vitest run tests/project-catalog.test.ts tests/activity-instructions.test.tsx tests/sandbox-lifecycle.test.ts --maxWorkers=2
RUN_LIVE_PROJECTS=1 node --env-file=.env.local node_modules/vitest/vitest.mjs run tests/live-projects.test.ts --maxWorkers=1
```

Live AI rubric quality, signed-in browser/axe/responsive behavior, actual embedded preview, deployed scheduling/monitoring, isolated Preview migration replay, OAuth/email verification and credential rotation remain release gates. Component tests and Vite builds do not prove those flows. See [SaaS release gates](./saas-release-gates.md).

The 2026-08-28 checkpoint passed the complete six-project Linux matrix in 98.5 seconds, including VM shutdown. The default suite passed 1,546 tests (16 live opt-ins skipped); the latest 157 focused catalog/UI/lifecycle checks also passed. Lint, TypeScript, Node 24 production build, production dependency audit and local anonymous-route HTTP smoke checks passed. Starter and reference source are also checked against the existing complete-JSON AI evidence limit; additional learner files can still exceed that limit. No production behavior or successful live AI assessment is inferred from these checks.
