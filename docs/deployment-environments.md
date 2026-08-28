# Deployment environments

Updated 2026-08-27. This is service configuration, **not production release approval**. See [release gates](./saas-release-gates.md).

## Verified configuration

| Service | Production | Preview |
| --- | --- | --- |
| Vercel app | `codetutor-studio`, Node 24 | Same app, isolated environment settings |
| Supabase database/Auth | `lyxbhjebtkvaihmjyjtk` | Not provisioned; organization and cost confirmation required |
| Supabase URL/publishable key | Configured in Vercel Production | Intentionally absent |
| Supabase server key | Configured as a sensitive Production variable | Intentionally absent |
| `CRON_SECRET` | Separate sensitive value configured | Separate sensitive value configured |
| AI Gateway/Sandbox tokens | Existing values still require rotation | Configure scoped replacements before live testing |
| Recovery scheduler | Minute cron is checked in, not deployed | Preview deployments do not run Vercel cron automatically |

The local `.env.local` has a third, independent worker secret and remains gitignored. Do not copy a hosted worker secret into browser code, logs, exports, or chat. Sensitive variables were added using stdin, not command-line values.

Sandbox credentials currently use `vercel-sandbox-default-project` (`prj_JP9PfTEAzWddZhN84kW2Izn7Hdeu`) on the same team as the application. This is an intentional provider-resource binding, not an application deployment. The environment validator accepts this reviewed project or the application project. It does not prove that an API token has appropriate scope; live ownership checks and credential rotation remain required.

## Preflight

`next.config.ts` runs an offline environment guard when `VERCEL=1`. The guard rejects:

- Missing or incorrect database origins and missing public/server keys.
- A Preview database equal to the Production database, including a mistakenly duplicated binding.
- Preview until its independent database reference is recorded in `lib/deployment/environment.ts`.
- Server credentials exposed through `NEXT_PUBLIC_` variables.
- Missing/weak worker authorization, credential reuse, wrong Node version, unreviewed projects/teams and target mismatches.
- Missing AI Gateway/Sandbox authentication or malformed credentials overriding OIDC.

Run it explicitly with an appropriately scoped private environment file:

```sh
node --env-file=.env.local scripts/check-deployment-env.mjs --target production
pnpm check:deployment --target preview
```

The first command checks the local configuration against Production bindings; it does **not** inspect or validate Vercel's deployed secrets. Passing proves configuration shape only, not key validity, rotation, database migrations/RLS, OAuth delivery, model availability, or release readiness. Ordinary local builds remain available without `VERCEL=1`.

A real `next build` with `VERCEL=1`, `VERCEL_ENV=preview` and the production database was verified to fail before compilation. A normal local production build passes.

## Worker verification

With a local production server running and an empty capture queue:

```sh
node --env-file=.env.local scripts/verify-source-worker-http.mjs
```

This checks missing/wrong authorization (401), the correct secret (200), private/no-store responses and request IDs. It refuses a nonempty queue, uses a local origin only, follows no redirects, and creates no VM, AI request, or email. One initial authorized check returned 503; repeated checks and the smoke script passed afterward. Claim failures now log a stage, bounded error code and timing without provider text. No root cause is claimed for that one-off failure.

Production still needs observed automatic cron execution, processing of real pending jobs after a process restart, and backlog/fairness tests. Manually invoking an empty queue is not proof of scheduled recovery.

## Release sequence

1. Confirm the Supabase organization and branch cost; provision an isolated Preview database and verify migrations, grants/RLS and callback allowlists there.
2. Record its reference and configure Preview-only public/server keys. Rotate the exposed AI Gateway and Vercel credentials, with appropriately scoped replacements.
3. Run the full release gates and deploy a protected Preview. Do not give Preview the production database to make a check pass.
4. Public `NEXT_PUBLIC_` values are embedded at build time. **Do not promote a Preview build connected to the Preview database directly into Production.** Create a production-target build from the verified source, initially without assigning the public domain (`vercel --prod --skip-domain`), verify that deployment, then promote that same production-target build. A staged Production deployment still has production credentials; it is not an isolated test environment.
5. Verify actual cron configuration/execution and runtime errors after release. Environment changes alone do not update an existing deployment. Check cron behavior explicitly during rollback; do not assume rolling back a deployment resets schedules.

References: [Vercel sensitive variables](https://vercel.com/docs/environment-variables/sensitive-environment-variables), [cron management](https://vercel.com/docs/cron-jobs/manage-cron-jobs), [Next.js environment variables](https://nextjs.org/docs/app/guides/environment-variables), [Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys).
