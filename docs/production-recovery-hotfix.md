# Published local-first recovery hotfix — 2026-08-28

The live application no longer runs the old undismissible expiration dialog. A separate, verified hotfix was published from `../codetutor-expiry-hotfix`; this unfinished authenticated SaaS worktree was **not** deployed or overwritten.

- Original production source: `dpl_91SxHF2W9hMFcy9GoVeSp4V58LZy`, recovered using Vercel's deployment-file APIs because it was a dirty CLI deployment not represented by a Git commit.
- Verified preview: `dpl_1oQpY7TqJ8SWvM9fe7XJCECzuhCf`.
- Current production: `dpl_JBAjW5pUHBCdVbzj8a9vafxiGgGn` at `https://codetutor-studio.vercel.app`.
- Repairs: controlled expiration-dialog dismissal/reopen, recovery-only error containment, bounded/validated restoration, no inactive-project UI mutation, and transactional IndexedDB project patches that durably save replacement sandbox IDs before publishing them to the UI.
- Patched Next.js/React/ESLint and DOMPurify without introducing authentication or changing the local database schema. Production audit: zero critical/high, one inherited moderate PrismJS advisory.
- Verification: 25 unit/component/persistence tests, targeted lint, a successful Vercel clean install/Turbopack build/TypeScript check, model-picker and Practice navigation smoke checks, and a real disposable sandbox create → restore → matching readback → stop flow.
- On the existing saved production project, Close and Not now now dismiss the popup, and Restore reopens it. No browser warnings/errors or immediate error-level runtime logs were captured. Customer source/chat were not cleared or modified.

The separate original global loading exception was not reproduced. Recovery rendering is now contained, but this is not proof of every possible application's exception being fixed. Source restoration remains limited to saved snapshots; dependencies/servers must be restarted as needed.

See `../codetutor-expiry-hotfix/HOTFIX.md` for exact scope and remaining limitations. Do not publish this directory's entire unfinished SaaS migration as a subsequent local-first bugfix. Existing documents describing that migration as undeployed remain applicable to it, not to the separate hotfix above.
