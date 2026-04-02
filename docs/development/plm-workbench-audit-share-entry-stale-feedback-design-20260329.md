# PLM Workbench Audit Share-Entry Stale Feedback Design

Date: 2026-03-29
Commit: pending

## Context

The audit panel already treats stale transient collaboration state as authoritative cleanup targets:

- collaboration drafts clear when their target team view disappears
- collaboration followups clear when their target team view disappears
- saved-view followups clear when their target saved view disappears

The remaining mismatch lived in the shared-entry flow opened from `auditEntry=share`.

Current behavior:

- `runAuditTeamViewShareEntryAction(...)` resolves the share-entry target from the canonical shared entry
- if that target disappears before the user clicks `save-local`, `duplicate`, or `set-default`, the resolver returns explicit feedback
- but the handler only reports the error and leaves the stale share-entry banner plus route marker in place

That leaves the audit panel in a worse state than the already-fixed followup flows: the user can keep clicking the same dead action banner even though the owning team view is already gone.

## Decision

Make share-entry action feedback follow the same stale-owner cleanup contract as the other audit transient states:

- when share-entry feedback is produced because the action target is missing
- clear the in-memory share-entry state
- consume the `auditEntry=share` route marker
- then report the canonical feedback message

## Why This Fix

- It removes a real stale state loop instead of only changing copy.
- It aligns shared-entry behavior with the collaboration/followup cleanup semantics already established elsewhere in the audit panel.
- It keeps the change local to audit frontend state handling; no backend or route-contract change is needed.

## Scope

Included:

- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/src/views/plmAuditTeamViewShareEntry.ts`
- `apps/web/tests/plmAuditTeamViewShareEntry.spec.ts`

Not included:

- no backend change
- no OpenAPI/SDK change
- no change to successful share-entry actions
