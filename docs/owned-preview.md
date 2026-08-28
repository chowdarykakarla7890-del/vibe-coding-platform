# Owned sandbox previews and manual startup

Verified locally on 2026-08-28. These changes belong to the unfinished authenticated SaaS worktree and are **not deployed**.

## Manual workflow

1. Sign in and open a Playground project.
2. Choose **Create file or folder → Create blank workspace**. This calls the owned-sandbox API directly, not the tutor. Existing saved source is validated and restored first; an unavailable source read is never interpreted as an empty project.
3. Create/edit/save files, then run a web server from the terminal in **Server** mode on an exposed port (manual startup exposes 3000).
4. Open **Preview**. Its read-only address is fetched from the server's owned sandbox, without asking an AI model for a URL. **Reconnect preview** revalidates the sandbox and reloads the frame.
5. After expiration, close recovery with **Not now** or **Close**, or restore saved files to a replacement. Dependencies and running servers are not restored: restart the server before opening its new preview.

Startup is bounded, prevents duplicate clicks, cancels obsolete project work and reuses restoration's cleanup/receipt handling. An acknowledged VM with an unconfirmed project refresh offers **Reopen project** instead of automatically creating another. Workspace hydration follows the server's project association; startup does not publish late results directly into another project's editor.

## API contract

- `GET /api/sandboxes/:sandboxId/preview?projectId=<uuid>&port=<optional exposed port>` reads the currently owned preview. It does not persist a selected origin.
- `POST /api/sandboxes/:sandboxId/preview` accepts exactly `{ projectId, port? }` and persists the verified origin, scoped by user, project, sandbox and running status.
- Success includes `{ projectId, sandboxId, url, port, ports, requestId }`. The client validates the receipt and matches the originating project/sandbox before rendering it.
- Both require authenticated ownership, use a 60/minute preview quota, private/no-store responses and a 30-second complete-request deadline. Client reads have a 20-second deadline; neither side retries indefinitely.
- Invalid queries/bodies are 400, missing ownership 404, stopped resources 410, quota exhaustion 429, and interrupted preview resolution 408. Other upstream errors use the shared structured error mapper.

The service derives origins with the [Sandbox SDK](https://vercel.com/docs/sandbox/sdk-reference) for registered exposed ports, with `resume: false`. Cached project URLs are not authoritative. Only exact HTTPS single-host `*.vercel.run` origins are accepted: no credentials, custom ports, paths, query strings, nested hosts or lookalike domains. The AI URL tool uses the same owned resolution path.

## Browser protections and limitations

- Project/sandbox changes, account changes, expiration and unmount cancel obsolete preview reads. Unrelated file/log updates do not reload the frame.
- The frame has a restrictive sandbox without top-navigation permission and uses `no-referrer`; external opening uses `noopener noreferrer`.
- Response headers restrict frames to `https://*.vercel.run`, deny embedding the application, disable object embedding, set `nosniff`, and restrict referrer/permissions policies.
- This is an embedding/navigation baseline, **not** a complete nonce-based script CSP. Full script CSP remains release work.
- Owned API access does not make the resulting temporary public sandbox URL private. Do not serve secrets through the preview.
- The frame's `load` event only confirms document loading, not application health. A stopped web process may display the platform's `SANDBOX_NOT_LISTENING` page; start the server and reconnect. Cross-origin application status is not inferred from `load`.

## Verification

- Default suite: **1,603 passed, 17 live tests skipped** across 106 passing files. Run with the bundled supported Python runtime via `CODETUTOR_TEST_PYTHON` for grading tests; the machine's older Python fails those independent harness checks.
- Lint, TypeScript, Node 24 production build, whitespace checks and production dependency audit pass.
- Opt-in `tests/live-preview.test.ts` passed against the local production app, hosted Supabase and one disposable VM: real SSR sessions, two-user isolation, same-user wrong-project denial, CSRF/body validation, port selection persistence, both served HTTPS origins, security headers and expiry. Test resources were cleaned up.
- Signed-in browser QA reproduced the old manual-start defect: the button dispatched an AI prompt that failed instead of creating the sandbox. After repair, manual startup, file creation, Monaco edit/save, terminal server, embedded page and reconnect passed without a chat request.
- Browser QA then deliberately stopped the disposable VM: the old iframe/link disappeared, the dialog closed and reopened correctly, saved HTML returned in a replacement sandbox, and restarting the server restored the preview. The pre-repair chat failure and expected no-server/expired-resource responses are not reported as a clean whole-session console run.
- The error monitor also logged two redacted analysis failures during the original Python server run. A later [automatic-diagnostics repair](./automatic-diagnostics.md) classifies benign stderr correctly and verifies that the browser server/reconnect flow produces no analysis requests. Successful live provider analysis remains unverified. The original fixture confirmed removal of its account, sessions, projects and both sandboxes afterward.

This does not prove customer email/OAuth delivery, live model generation, background capture scheduling, all responsive/accessibility paths or Vercel production behavior. See [release gates](./saas-release-gates.md).
