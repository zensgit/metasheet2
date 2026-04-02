# PLM Audit Scene Team Collaboration Design

Date: 2026-03-20
Branch: `codex/plm-workbench-collab-20260312`

## Goal

After a scene-context quick save writes an audit team view, immediately continue into the existing team collaboration path instead of stopping at a plain status message.

## Design

### 1. Reuse the existing team-view collaboration surface

The audit page already had a collaboration draft and follow-up model for:

- recommended audit team views
- saved-view promotion into team views

This slice extends the same model with a third source:

- `scene-context`

The UI stays consistent with the existing collaboration controls.

## 2. Add scene-context source semantics

`plmAuditTeamViewCollaboration.ts` now treats `scene-context` as a first-class source for:

- draft status copy
- share status copy
- default-promotion status copy
- share follow-up source labels
- return-to-source actions

This keeps scene quick-save aligned with the rest of the audit collaboration flow.

## 3. Connect scene quick-save to collaboration entry points

`PlmAuditView.vue` now routes scene quick-save outcomes into the collaboration path:

- `Save scene to team`
  - creates a collaboration draft for the saved team view
  - focuses the team-view controls section
- `Save scene as default`
  - creates a collaboration follow-up that points to matching audit logs
  - keeps the scene-context anchor as the return target

## 4. Preserve source-aware return navigation

The follow-up notice now uses source-specific anchors:

- recommended card -> `plm-audit-recommended-team-views`
- saved-view promotion -> `plm-audit-saved-views`
- scene quick-save -> `plm-audit-scene-context`

This lets the collaboration flow return the user to the origin that created the team view.

## Result

Scene-context quick-save is now a complete collaboration path:

- save to team
- copy share link
- set as default
- jump back to the originating scene context

without introducing a separate UI model just for scene-driven audit views.
