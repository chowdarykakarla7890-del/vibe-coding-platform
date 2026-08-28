# Reproducible checks and release activation

Updated 2026-08-28. The workflow is active on GitHub in [draft PR #1](https://github.com/chowdarykakarla7890-del/vibe-coding-platform/pull/1), starting with checkpoint `806244a7de710689d9c8938adfaf75482ac7fb7c`. The first clean database job passed; the application job exposed a Linux-only test-fixture failure described below. It is not yet a required branch check, and the SaaS migration has not been deployed.

The checkpoint was created with an alternate Git index and a separate `codex/saas-release-validation` branch. The original dirty `main` worktree and its staging state were preserved. This branch is for review and validation, not automatic production promotion.

The repository's existing Vercel Git integration independently attempted a Preview build in project `vibe-coding-platform` (`prj_9s8nS7kAGE6StaY7nMHy9NXVVZVv`). Its build was blocked by the reviewed-project, team, isolated-Preview-database and service-secret checks. That is a configuration gate, not a reason to allow Production database credentials in Preview. This integration is distinct from the live `codetutor-studio` project. No integration settings or production aliases were changed.

Latest hosted HTTP/database regression: `verify-auth-projects.mjs` passes after teaching its database-only fixtures to settle their own never-launched sandbox cleanup tombstones. These operational records intentionally survive deletion in production; fake fixtures must not fill the concurrency quota or race a deletion worker. The runner validates its own handles and refuses active leases, without weakening application cleanup. See [custom-generation checkpoint](./custom-activity-generation.md). This hosted run still does not prove the clean Docker replay job.

## What runs

`.github/workflows/ci.yml` runs on pull requests, pushes to `main`, and manual dispatch. It has read-only repository permissions, no persisted checkout credentials, immutable action commit references, bounded job durations and cancellation of superseded runs. It does not reference deployment secrets, use `pull_request_target`, upload builds, push changes or deploy.

1. **Application checks:** Node `24.18.0`, pnpm `11.19.0`, frozen clean install, lint, route type generation, TypeScript, the non-live Vitest suite, high/critical production dependency audit, production build and a local HTTP smoke test. Public Supabase values are deliberately non-production fixtures; no AI or VM credentials are provided. The resulting build is not deployable customer software.
2. **Database replay and isolation:** Supabase CLI `2.116.0` starts a disposable local Docker stack, resets only that local database, replays all migrations, checks SQL compilation, runs all transactional `supabase/tests/*.sql` assertions and compares the resulting public TypeScript contract with the checked-in types. It then builds against the local database and runs the two-user authenticated API suite plus the synthetic cleanup protocol suite. No hosted project link or production database is used. An `always()` step removes only this job's local database volumes.
3. **Required checks:** succeeds only when both jobs succeed, including when one fails or is skipped. This is a named check to require in branch protection; declaring it in YAML does not configure protection automatically.

The database type comparison ignores formatting, comments and platform-specific metadata outside `Database.public`. It does not ignore table, column, nullability, relationship or function-contract differences. Type drift fails the job rather than overwriting the checked-in file.

## Local commands

Use the Node release in `.node-version`, install the pinned pnpm version, then:

Use Python 3.11+ for filesystem-safety tests. On machines with an older system `python3`, set `CODETUTOR_TEST_PYTHON` to a compatible executable; the grading-cleanup suite fails with setup guidance rather than skipping safety checks. The workflow uses Ubuntu 24.04's Python runtime. Practice and Debug execution tests also require Java 21 (`javac`/`java`) and C++17 (`g++`); the workflow checks their availability before installation/tests. Unlike the opt-in paid VM matrices, local lesson execution is part of the default suite and is not silently skipped when a compiler is missing.

```sh
node scripts/check-toolchain.mjs
pnpm install --frozen-lockfile
pnpm lint
pnpm exec next typegen
pnpm type-check
pnpm exec vitest run --maxWorkers=2
pnpm audit --prod --audit-level=high
pnpm build
```

`pnpm check:ci-smoke` starts and stops its own loopback-only child on port 3115. Run it against a build made with non-production public configuration; it is not an authenticated browser test. It checks the sign-in page, signed-out workspace redirect, eight ordered model tiers, and a structured 401 from the protected project API. It never kills an unrelated process occupying that port.

`scripts/ci-database.mjs` deliberately refuses ordinary developer execution. It requires disposable GitHub CI, rejects private `.env` files, accepts only the fixed local Supabase origin, and never receives arbitrary database URLs. Do not bypass this guard to reset a hosted database. Local SQL assertions can be run manually on an explicitly disposable Supabase stack using `psql -X -v ON_ERROR_STOP=1`; each checked-in assertion file rolls back its fixtures.

## Verified on GitHub

The [first Linux run](https://github.com/chowdarykakarla7890-del/vibe-coding-platform/actions/runs/33137880560) completed on 2026-08-28:

- The disposable database job passed: all 39 migrations replayed from empty, SQL lint, all eight transactional SQL suites, exact public database type parity, a fresh production build against local Supabase, two-user cookie-authenticated HTTP checks, and the synthetic cleanup protocol suite. Temporary accounts and the job-owned database were cleaned up.
- Docker image pulls initially encountered registry rate limits; the CLI recovered and the database job completed. This run does not establish reliability under sustained registry throttling.
- The application job passed clean installation, lint, route type generation and TypeScript. Vitest reported 1,944 passed, one failed, and 17 opt-in tests skipped. `command-output.test.ts` passed a 165 KB string as one argument, exceeding Linux's per-argument limit (`E2BIG`) before the encoder launched. The fixture now generates the same output inside its child process using a small Unicode argument and repeat count. Output length, stream separation, literal argument preservation and nonzero exit coverage are unchanged; no application behavior was weakened to bypass the test.
- The corrected command-output and release-pipeline tests pass locally (19 tests). A new full GitHub run is required before calling the application job green. The aggregate Required checks correctly failed while one job failed; subsequent audit/build/smoke steps in that application job were not run.

## Earlier local verification

- Exact-version frozen install in a fresh temporary copy with no existing `node_modules`, build output, Git credentials, Vercel link or private environment files. Dependencies were reused from pnpm's content-addressed cache; this was not a cold network-download test.
- That clean copy passed lint, fresh Next route type generation, TypeScript, 1,015 non-live tests, a production build using non-secret public fixtures, and the real loopback HTTP smoke check. A subsequent additional regression verifies the destructive database harness refuses non-CI execution.
- Workflow syntax/action validation passed with checksum-verified actionlint `1.7.12`; optional external ShellCheck/Pyflakes integrations were not run.
- The transactional security assertions passed against the existing hosted schema and rolled back fully: exposed-table RLS, invoker-safe progress view, server-only record/RPC grants, two-user row isolation, ownership-update denial and denied browser cleanup claims. This is **not** evidence of clean local migration replay.
- The production dependency audit reports no known vulnerabilities for the pinned dependency graph. Existing runtime code, pending product work and private environment files were preserved.
- The final current-worktree run passes 1,016 tests (ten opt-in live tests skipped), lint, TypeScript and diff checks, including the additional non-CI refusal test.

## Still required before release

1. Review the complete checkpoint in draft PR #1. The branch is pushed and the pull-request workflow is active; it must not be merged or deployed solely because it exists.
2. Complete a green full Linux run after the command-output fixture repair. Clean Docker replay, SQL lint and generated-type parity now have real GitHub evidence, rather than being inferred from hosted tests; the complete application pipeline still needs to pass.
3. Require the workflow's **Required checks** in the protected production branch. Review the repository's Vercel Git integration too: a checks-only workflow does not itself prevent independent automatic deployments or manual production pushes.
4. Keep Preview isolated from Production, complete provider funding/credential rotation and OAuth/email checks, then verify the actual deployment environment and remaining [SaaS release gates](./saas-release-gates.md).
5. Do not promote the fixture CI artifact. A Preview build compiled with Preview database bindings must not be silently reused as a Production build. Verify the target-bound build and runtime configuration explicitly before assigning the production domain.

This implementation follows the [GitHub Actions secure-use guidance](https://docs.github.com/en/actions/reference/security/secure-use) and [Supabase local testing guidance](https://supabase.com/docs/guides/local-development/testing/overview). No external checks or deployment claims are inferred solely from the workflow file.
