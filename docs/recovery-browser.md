# Saved-work recovery browser gate

The recovery flow is part of the disposable production-build Chromium suite.
It must pass on the exact release candidate; a checked-in script is not evidence
of a successful deployment or live VM restoration.

The browser signs in through the existing local email/PKCE flow. It then reads
real owned source from a synthetic expired registration, downloads source JSON
and a complete NDJSON archive, and imports both through the actual staged upload
and atomic publication APIs. The source receipt survives a reload before the
user explicitly opens its new project. Imported history stays read-only and
unverified; it never becomes active chat, tool calls or awarded assessments.

The checks compare Unicode file contents, revisions, archive ordering and hashes,
original-project preservation, empty runtime associations, model selection,
dialog focus, and automated accessibility. Only the VM lifecycle response is
simulated. AI generation, VM creation and VM mutations are forbidden. All users,
projects, downloads and registrations belong to the disposable CI environment;
no source, archive, authentication data or raw page exception is published in logs.

## Repairs covered

- Source export refuses dirty editor drafts, including edits begun while its
  saved-source request is running. It does not discard or claim to include them.
- Project changes and unmounts cancel source-export pagination. Late results
  cannot start a download in a replacement workspace. Account cancellation
  continues to use the existing account-bound request layer.
- A completed source download retains its object URL for 60 seconds so the
  browser can consume it before revocation.
- Source/archive import, archive export and imported-history dialogs return
  keyboard focus to the project switcher. Opening a recovered project hands
  focus across the workspace's asynchronous remount.
- Shared buttons no longer animate disabled opacity into the enabled state and
  honor reduced motion. Browser checks assert the resulting computed styles;
  normal color transitions and the existing palette remain unchanged.

Focused tests first reproduced five source-export failures and two focus failures.
Their repairs are verified locally; clean build/browser evidence is recorded
against the validation branch in the pull request. No production deployment,
hosted migration, paid resource, legacy-device deletion or account setting change
is part of this checkpoint. Actual replacement-VM restoration, cross-browser
downloads, large-device-memory behavior, hosted Preview and cleanup scheduling
remain distinct release gates.
