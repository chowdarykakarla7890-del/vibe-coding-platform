# Reproducible checks and release activation

Updated 2026-08-28. The workflow is implemented locally; it has not run on GitHub, been made a required branch check, or deployed the application.

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

## Verified in this workspace

- Exact-version frozen install in a fresh temporary copy with no existing `node_modules`, build output, Git credentials, Vercel link or private environment files. Dependencies were reused from pnpm's content-addressed cache; this was not a cold network-download test.
- That clean copy passed lint, fresh Next route type generation, TypeScript, 1,015 non-live tests, a production build using non-secret public fixtures, and the real loopback HTTP smoke check. A subsequent additional regression verifies the destructive database harness refuses non-CI execution.
- Workflow syntax/action validation passed with checksum-verified actionlint `1.7.12`; optional external ShellCheck/Pyflakes integrations were not run.
- The transactional security assertions passed against the existing hosted schema and rolled back fully: exposed-table RLS, invoker-safe progress view, server-only record/RPC grants, two-user row isolation, ownership-update denial and denied browser cleanup claims. This is **not** evidence of clean local migration replay.
- The production dependency audit reports no known vulnerabilities for the pinned dependency graph. Existing runtime code, pending product work and private environment files were preserved.
- The final current-worktree run passes 1,016 tests (ten opt-in live tests skipped), lint, TypeScript and diff checks, including the additional non-CI refusal test.

## Still required before release

1. Commit/review the complete intended changes and activate this workflow on GitHub. No commit, push, branch-protection change or CI dispatch was made in this checkpoint.
2. Run and inspect the Linux/Docker job. This workstation has no Docker engine, so clean database replay, local SQL lint and generated-type parity remain unverified. Do not mark this gate green based on the hosted test above.
3. Require the workflow's **Required checks** in the protected production branch. Review the repository's Vercel Git integration too: a checks-only workflow does not itself prevent independent automatic deployments or manual production pushes.
4. Keep Preview isolated from Production, complete provider funding/credential rotation and OAuth/email checks, then verify the actual deployment environment and remaining [SaaS release gates](./saas-release-gates.md).
5. Do not promote the fixture CI artifact. A Preview build compiled with Preview database bindings must not be silently reused as a Production build. Verify the target-bound build and runtime configuration explicitly before assigning the production domain.

This implementation follows the [GitHub Actions secure-use guidance](https://docs.github.com/en/actions/reference/security/secure-use) and [Supabase local testing guidance](https://supabase.com/docs/guides/local-development/testing/overview). No external checks or deployment claims are inferred solely from the workflow file.
