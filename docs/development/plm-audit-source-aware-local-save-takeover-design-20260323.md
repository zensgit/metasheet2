# PLM Audit Source-Aware Local Save Takeover Design

Date: 2026-03-23

## Goal

Make generic local saves and recommendation-driven management handoffs respect the same transient ownership rules as dedicated `shared-entry` and `scene-context` entry flows.

## Problems

Two user-visible inconsistencies remained:

1. `scene-context -> Save current view` created a local saved view but skipped the `scene-context` followup, so users lost the next-step prompt to promote the saved view into team/default state.
2. `shared-entry -> recommendation management handoff` prepared a collaboration draft for the same team view, but the existing shared-entry banner still owned the screen and hid that draft.

## Decision

Treat generic local save as a source-aware operation and treat recommendation management for the active shared team view as a `shared-entry` takeover.

That yields one consistent ownership rule:

- if the active selection still matches a shared-entry owner, generic local-save or recommendation-management actions consume the shared-entry state
- otherwise generic local-save falls back to `scene-context` when a visible scene banner still owns the audit view
- plain local-save remains unchanged when no transient owner applies

## Implementation

Files:

- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/src/views/plmAuditSavedViewShareFollowup.ts`
- `apps/web/src/views/plmAuditTeamViewShareEntry.ts`
- `apps/web/tests/plmAuditSavedViewShareFollowup.spec.ts`
- `apps/web/tests/plmAuditTeamViewShareEntry.spec.ts`

Key changes:

- add `resolvePlmAuditSavedViewLocalSaveFollowupSource(...)` to resolve `shared-entry` vs `scene-context` vs no followup
- route both generic local-save and dedicated shared-entry local-save through the same followup-installing helper
- add `shouldTakeOverPlmAuditSharedEntryOnManagementHandoff(...)`
- when recommendation management targets the active shared team view, clear local shared-entry state and consume `auditEntry=share` before showing the collaboration draft

## Expected Outcome

- `scene-context -> Save current view` now shows the same local followup as the dedicated scene save CTA
- `shared-entry -> recommendation management` no longer leaves the shared-entry banner sitting on top of the active collaboration draft
- transient ownership stays aligned with the currently active source instead of diverging between “dedicated CTA” and “generic control” paths
