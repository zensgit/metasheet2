# PLM Audit Scene Save Follow-up Design

Date: 2026-03-20
Branch: `codex/plm-workbench-collab-20260312`

## Goal

After a scene-context quick save stores a local audit view, immediately offer the next useful actions:

- promote to team
- promote as default team view

instead of leaving the user with only a status toast.

## Design

### 1. Reuse the existing saved-view follow-up notice

The audit page already had a follow-up surface for:

- team-view share entry saved locally

This slice keeps the same notice and action set, but adds a source discriminator so it can also represent:

- scene-context quick save

## 2. Add a follow-up source

`plmAuditSavedViewShareFollowup.ts` now carries:

- `source: 'shared-entry' | 'scene-context'`

The notice copy changes by source, while actions stay identical:

- `Save to team`
- `Save as default team view`
- `Done`

## 3. Connect scene quick-save to the same follow-up

`PlmAuditView.vue` now:

- saves the local scene audit view
- stores the returned saved-view id
- records `source: 'scene-context'`
- scrolls to the saved-view section

This keeps the new scene shortcut and the existing saved-view promotion path unified.

## Result

Scene-context quick save is no longer a dead-end local action. It now hands the user straight into the same promotion flow already used elsewhere in the audit workbench.
