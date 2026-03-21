# PLM Audit Scene Save Shortcuts Design

Date: 2026-03-20
Branch: `codex/plm-workbench-collab-20260312`

## Goal

Turn the audit scene context banner into a direct save/promotion entry point.

The audit page already knew:

- which scene recommendation opened it
- how to restore the current scene filter
- how to save local audit views
- how to save audit team views

This slice connects those capabilities so scene-focused audit work can be saved without manually retyping names in the saved-view or team-view sections.

## Design

### 1. Add a scene-save draft helper

`plmAuditSceneSaveDraft.ts` generates:

- `savedViewName`
- `teamViewName`
- a short description for the shortcut row

from the current audit scene context:

- `sceneName`
- `sceneId`
- `sceneOwnerUserId`
- recommendation reason

This keeps naming logic out of the page component.

## 2. Reuse existing save chains instead of adding a new persistence path

`PlmAuditView.vue` now reuses the existing save flows:

- local saved view storage
- audit team view persistence
- default audit team view persistence

The only new orchestration is:

- choose the prebuilt draft name
- call the existing save path
- scroll to the relevant section after success

## 3. Expose three context-level quick actions

When scene context exists, the audit banner now shows:

- `Save scene view`
- `Save scene to team`
- `Save scene as default`

These are scene-aware shortcuts, not replacements for the existing detailed save controls further down the page.

## Result

Scene-driven audit work can now be captured immediately from the context surface, while still funneling into the same local/team persistence model that the rest of the audit workbench already uses.
