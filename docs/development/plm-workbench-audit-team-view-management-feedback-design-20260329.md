# PLM Workbench Audit Team View Management Feedback Design

Date: 2026-03-29
Commit: pending

## Context

`PlmAuditView.vue` still had several management entry points that silently returned when the current audit team view target was missing, locked by canonical route ownership, already in a no-op lifecycle state, or denied by permissions. The shared workbench team view and team preset flows had already been hardened to surface explicit feedback for the same conditions.

The remaining gap was concentrated on the audit team view lifecycle and default actions:

- `setAuditTeamViewDefault()`
- `clearAuditTeamViewDefault()`
- `archiveAuditTeamView()`
- `restoreAuditTeamView()`
- `deleteAuditTeamView()`

## Decision

Introduce a pure feedback resolver for audit team view management actions and route the five silent-return handlers through it before attempting mutation.

New helper:

- `apps/web/src/views/plmAuditTeamViewManagementFeedback.ts`

The helper centralizes these precedence rules:

1. No selected target: require explicit selection feedback.
2. Locked management target: require the user to apply the selected team view first.
3. Read-only target: return creator-only denial for the specific action.
4. No-op lifecycle/default states:
   - already default
   - not default
   - already archived
   - restore not needed
5. Archived restore-first and generic unavailable actionability messages.

`PlmAuditView.vue` now uses this resolver for the five lifecycle/default actions so direct handler calls and UI-triggered paths share the same explicit outcome semantics.

## Why This Shape

- Keeps the component logic small and avoids scattering another set of conditional status messages across five handlers.
- Makes the behavior testable without mounting the full audit screen.
- Aligns audit team view management with the existing workbench team view/team preset action-feedback model.

## Non-Goals

- This change does not yet cover `share`, `rename`, `transfer`, or `duplicate` in the audit team view panel.
- This change does not alter backend permissions or lifecycle semantics; it only makes the frontend management feedback explicit and consistent.
