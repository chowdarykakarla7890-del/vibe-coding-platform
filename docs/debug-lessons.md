# Debug exercises

The 12 Debug activities now contain working-looking implementations with specific behavioral bugs, not generic TODO stubs. Each defines an exact contract, examples, reproducible failing assertions, three progressive hints, two concept questions and diagnosis prompts. Original IDs and catalog order are preserved.

| Track | State bug | Edge cases |
| --- | --- | --- |
| JavaScript | Shallow copy mutates original stock objects | Pagination drops the last item of each page |
| TypeScript | Adjacent conditionals discard a valid state transition | `parseInt` accepts malformed limit strings |
| React | Batched updates lose one increment | Index keys attach uncontrolled drafts to the wrong item |
| Python | Mutable default list leaks notes between calls | Inclusive end boundary double-counts adjacent windows |
| Java | Static cart field shares state across instances | Integer accumulator overflows before returning a long |
| C++ | Erasing while incrementing skips neighboring completed tasks | Even median truncates fractions and overflows before conversion |

## Learner workflow

Open **Instructions** to read the contract and reveal hints. Run the displayed regression command before editing, then repair the implementation and retain the supplied checks. Add a boundary check of your own. Record reproduction, root cause, focused repair and regression evidence in `DIAGNOSIS.md`; answer the concept questions in `REFLECTION.md`. Both files are saved with the submitted source.

The dialog shows the check command without executing it. It labels submissions **AI-assessed**, not trusted deterministic grading. The rubric weighs behavior 60%, focused design 20%, preserved/added checks 10%, and diagnosis/reflection 10%. Passing learner-editable checks alone does not confer a trusted score. DSA graders are unchanged.

Existing projects keep their saved files. Catalog updates never overwrite source; create a new Debug project for the new seeded bug, or adapt older source explicitly. Historical submissions retain their original manifest. The API and storage schema are unchanged.

## Runtime preparation

JavaScript/TypeScript use Node 24's test runner; TypeScript also includes a separate strict typecheck script. Python uses standard-library unittest. React uses pinned Vite/Vitest/React dependencies and interaction tests, with a preview on port 3000. Java/C++ run `python3 check.py`, which compiles and executes assertions before deleting its temporary build directory. See [shared lesson toolchains](./practice-lessons.md#toolchains-and-commands).

Fresh owned Java/C++ sandboxes use shared compiler preparation, selected only by an exact curated Practice, Debug or Project ID and matching language. Fixed server-controlled package arguments run before the VM is attached to the project. Unknown/generated IDs and mismatched languages cannot request this privileged setup. Failure or cancellation uses existing reservation/VM cleanup. This does not make editable regression scripts trusted graders. Restoring a source snapshot prepares the compiler again; excluded React/TypeScript dependencies need reinstalling.

## Verification and limits

`tests/debug-catalog.test.ts` validates all 12 contracts, teaching material, IDs/order, schema limits and compiler eligibility. It executes every starter, requires an assertion failure rather than a missing compiler or syntax error, applies a minimal test-only implementation repair, and reruns unchanged checks successfully. TypeScript starters are type-correct despite the behavioral bug; repaired React projects also build. Repair fixtures are not imported into learner code.

`tests/activity-instructions.test.tsx` checks diagnosis guidance, the regression label and honest assessment wording. Sandbox lifecycle tests cover all curated compiled-language activities, setup-before-attachment, failure cleanup, and rejection of ineligible compiler setup.

The opt-in `tests/live-debug.test.ts` repeats every failing-assertion/passing-repair pair in one disposable Linux VM, installs the exact pinned React dependencies, builds both repaired React projects, and stops the VM in `finally` (including lookup by its unique name after a lost creation receipt). Run only with authorized Sandbox credentials:

```sh
RUN_LIVE_DEBUG=1 node --env-file=.env.local node_modules/vitest/vitest.mjs run tests/live-debug.test.ts --maxWorkers=1
```

This matrix uses Sandbox resources but no AI calls, customer source or test accounts. It verifies toolchains and content, not signed-in browser/API/assessment integration. Deterministic Debug grading, successful live AI assessment, full browser/axe checks and deployment remain release gates. The later [Challenge checkpoint](./challenges.md) replaces its 18 generic entries; the subsequent [Project checkpoint](./project-blueprints.md) replaces the six generic blueprints with concrete, staged workflows. Project submissions remain AI assessed.

The 2026-08-28 Linux matrix passed in 78 seconds, including confirmed VM shutdown. All 1,442 default tests passed (13 live opt-ins skipped); lint, TypeScript, the Node 24 production build, whitespace checks and the production dependency audit also passed. No database migration, credential rotation, deployment or customer-data mutation was made.
