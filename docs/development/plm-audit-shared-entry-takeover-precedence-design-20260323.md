# PLM Audit Shared-Entry Takeover Precedence Design

Date: 2026-03-23

## Goal

Ensure shared-entry ownership yields consistently when a higher-priority transient owner takes over, and keep shared-entry actions pinned to the same canonical target that the notice is describing.

## Problems

Two related issues remained after canonical notice targeting:

1. `Duplicate for my workflow` in the shared-entry notice still duplicated the local selector target instead of the canonical shared-entry target.
2. recommendation-driven management/share/set-default actions on another team view could coexist with the old shared-entry owner, leaving the shared-entry notice and the new collaboration draft/followup visible at the same time.

## Decision

Define a single precedence rule:

- shared-entry local saves remain selector-sensitive and only consume shared-entry when the selected team view still matches the entry target
- shared-entry notice actions resolve their target from the canonical entry target first, then fall back to the local selector only when no entry target exists
- any source-aware collaboration owner takes precedence over an active shared-entry owner

## Implementation

Files:

- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/src/views/plmAuditTeamViewShareEntry.ts`
- `apps/web/tests/plmAuditTeamViewShareEntry.spec.ts`

Key changes:

- add `resolvePlmAuditTeamViewShareEntryActionTarget(...)` so shared-entry actions use the same canonical target as the notice
- split `duplicateAuditTeamViewEntry(...)` from the generic template click handler so shared-entry duplication can target the canonical entry view explicitly
- broaden `shouldTakeOverPlmAuditSharedEntryOnManagementHandoff(...)` so recommendation drafts always consume an active shared-entry owner
- broaden `shouldTakeOverPlmAuditSharedEntryOnSourceAction(...)` so source-aware collaboration followups also consume an active shared-entry owner

## Expected Outcome

- `Duplicate for my workflow` now duplicates the team view named by the shared-entry notice
- recommendation-driven collaboration drafts/followups no longer coexist with an older shared-entry owner
- shared-entry ownership, notice rendering, and action targets stay on the same precedence model
