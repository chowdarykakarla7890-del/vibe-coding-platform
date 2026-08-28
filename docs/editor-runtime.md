# Pinned editor runtime and recovery

The application installs Monaco `0.56.0`. Previously, `@monaco-editor/react`
delegated to the loader's default CDN configuration, which downloaded `0.55.1`
instead. A clean dependency audit therefore did not prove which editor version
the browser executed.

Next's development/build configuration now copies the installed package's
`min/vs` distribution, workers and license notices to the versioned public
`/vendor/monaco/<exact package pin>/` directory. The copy fails if the installed
version differs from the direct pin or essential assets are missing. It runs
for direct `next build` as well as package scripts. Generated assets are ignored
by Git and ESLint; clean builds reproduce them from the frozen lockfile.

The editor and diff use one configured loader with a same-origin path. Public
runtime assets bypass the authentication proxy; they contain library code only,
not source files, credentials or account data. Workspace and source APIs retain
their existing authentication and ownership checks. No CDN fallback is used.

Runtime initialization has a 20-second limit. Rejection or timeout shows a
labeled basic textarea instead of an indefinite spinner. The parent retains
the draft, saved revision, save/conflict handling and read-only expiry state.
Basic mode supports the existing Save action and Ctrl/Cmd+S; comparison shows
both saved and draft buffers read-only. A late runtime download does not replace
the focused basic editor. Save or copy a draft before reloading to retry Monaco;
the upstream loader caches rejected initialization, so the UI does not advertise
a nonfunctional same-page retry.

Actual-browser accessibility checks also exposed unnamed native diff inputs and
low-contrast keywords on the default diff backgrounds. Both panes now have
explicit accessible names, diff backgrounds retain readable syntax contrast,
and the selected-file heading uses the existing readable muted-text token.
Further browser diagnostics showed empty labels with both native EditContext
and textarea inputs. Monaco's diff configuration updates can clear the
construction-only labels, so a guarded configuration listener maintains each
name through the public editor API and disposes with the diff editor. Valid
accessibility-help suffixes are retained, and already-correct labels trigger no
updates. The input backend remains unchanged. The browser verifies actual input
names as well as running axe; visually hidden text inputs are not required to
appear as visible fields.

Real diff teardown also exposed the pinned React wrapper disposing its models
while they were still attached to Monaco's diff widget. A minimal checked-in
`@monaco-editor/react@4.7.0` patch detaches the model first in both ESM and
CommonJS builds, then preserves the original keep/dispose flags and widget
cleanup. Installed-package tests verify ordering and all keep-flag combinations;
the browser repeatedly switches between editor and diff and checks that the
model count returns to its starting value. The patch must be reviewed when
upgrading the wrapper, not carried forward blindly.

The editor font stack no longer references the undefined `--font-geist-mono`
variable. That invalidated the entire CSS font declaration, allowing Monaco's
document-body measurements and its visible text to inherit different fonts.
An explicit monospace fallback stack keeps measurements and rendering aligned
without an external font download.

## Verification scope

- Unit tests cover pin/config alignment, asset packaging, missing/mismatched
  distributions, auth-proxy matching, loading success/failure/timeout, late
  completion, cleanup, keyboard save, read-only source and comparison buffers.
- The production HTTP smoke check compares served loader/editor/worker bytes
  with SHA-256 hashes of the installed package, without authentication.
- The disposable Chromium suite uses real local email/PKCE authentication and
  authenticated database-backed source reads. It types into the actual Monaco
  editor, renders a changed-line diff, verifies worker origins, runs axe, and
  holds the loader response to check basic-mode recovery and draft preservation.
  Axe's browser helper is injected in a lexical scope without AMD/CommonJS
  bindings: repeated accessibility scans must not register test modules in
  Monaco's loader. The page's globals remain untouched, every existing axe rule
  stays enabled, and all console warnings/errors still fail verification.
- The browser editor fixture simulates **only** VM status for an owned synthetic
  expired registration, forbids VM/file mutations and leaves saved source
  unchanged. It is not a live sandbox save/restore or production deployment test.
  The existing source-revision and live opt-in suites cover those separate
  boundaries. Temporary accounts and registrations are cleaned up in `finally`.

The broader nonce-based script CSP and hosted Preview/production verification
remain release gates. This change does not provision services, consume paid AI
or Sandbox resources, rotate credentials or promote a deployment.
