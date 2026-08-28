# Navigation and workspace accessibility checkpoint

Verified locally on 2026-08-28. These changes belong to the unfinished authenticated SaaS worktree and are **not deployed**. They do not change database schemas, authentication, AI tools or sandbox lifetime.

## Repairs

- The mobile navigation is a named modal drawer using the existing Radix Dialog. Closed navigation is unmounted, focus is contained while open, Escape closes it, and the trigger receives focus afterward. Desktop navigation is hidden below its breakpoint rather than translated offscreen while its links remain tabbable. Resizing to desktop closes the drawer and the media-query listener is cleaned up.
- Collapsed navigation retains explicit accessible link names and current-route state. Expandable sections expose their associated content through `aria-controls`.
- Modified navigation clicks no longer clear the current workspace's unsaved-file marker. Navigating to the current pathname also leaves the draft intact; changing routes still requires the existing discard confirmation.
- Create/rename inputs have associated visible labels. Closing the project popover no longer steals autofocus from the dialog it just opened. Popovers and dialogs have viewport-bounded scrolling, and dialogs respect reduced-motion preferences.
- Creating or selecting a project can temporarily unmount the header while authoritative chat history loads. A next-tick focus callback was insufficient: browser QA reproduced focus falling onto the page body. The replacement waits for the exact project's trigger, then restores focus only when no other control owns it. New pointer/keyboard interaction, a different project/account workspace, a superseding request or a 30-second deadline cancels this handoff and disconnects its observer. This is a focus deadline, not the chat inactivity timeout.
- Below the workspace's `xl` breakpoint, Tutor/Workspace buttons select one full-height pane instead of forcing two narrow columns or stacked half-height panes. Both panes stay mounted, preserving drafts and chat subscriptions. Desktop columns remain at `xl`; the header can shrink without displacing project controls.

The modal behavior follows the existing [Radix Dialog API](https://www.radix-ui.com/primitives/docs/components/dialog) and [WAI-ARIA modal-dialog guidance](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/). React guidance informed retaining mounted pane state and cleaning up the breakpoint listener; no dependency was added.

## Verification

- Full local suite: **1,706 tests passed, 17 live opt-in tests skipped**, across 116 passing files. Lint, TypeScript, Node 24 production build, whitespace checks and production dependency audit pass.
- Twenty-one focused tests cover real Radix focus containment/Escape/return, names and active states, modified-click draft preservation, breakpoint listener cleanup under Strict Mode, pane state preservation, project form submission, immediate and delayed workspace remounts, and cancellation of obsolete focus handoffs.
- In the local production build, a disposable authenticated browser session visited all seven learning routes. Each displayed its expected workspace/catalog/builder. Create, rename and switch operations succeeded against the account-backed project API; the labeled input received focus and, after the final repair, create/switch returned focus to the correct new trigger. Collapsed desktop links retained names. Browser warning/error output was empty for these flows.
- The browser fixture confirmed removal of its temporary account, sessions and four projects. No AI generation or sandbox was created for this checkpoint, and no existing user resources were deleted. The preview was left signed out.

## Limits / release gates

Browser evidence is from the available **1280 × 720** viewport. Phone/tablet layout, touch interaction, native end-to-end keyboard traversal, screen-reader behavior, zoom and axe checks remain unverified. The component tests exercise focus and breakpoint behavior in jsdom; they do not prove rendered CSS layout or assistive-technology compatibility. Browser keyboard automation did not provide reliable activation evidence, so no manual keyboard pass is claimed.

This checkpoint does not prove live AI streaming, expired-sandbox restoration, customer sign-in delivery, deployed source-capture scheduling or production readiness. Earlier recovery checks and outstanding database/CI, credential, provider and deployment requirements remain in [SaaS release gates](./saas-release-gates.md). No push, deployment, credential rotation or production promotion was performed.
