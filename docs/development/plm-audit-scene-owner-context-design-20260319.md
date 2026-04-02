# PLM Audit Scene Owner Context Design

Date: 2026-03-19
Branch: `codex/plm-workbench-collab-20260312`
Workspace: `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench`

## Goal

Turn the audit scene-context banner from a passive explanation into an actionable shortcut that helps users pivot from a recommended team scene to owner-related audit activity.

## Problem

The previous scene-context banner only explained why the user arrived at `/plm/audit`. It did not help the user move between:

- the original scene-oriented audit query, and
- owner-oriented audit exploration

That forced manual filter edits even though the banner already contained the owner id.

## Design

### Owner context shortcut

When the audit route contains `sceneOwnerUserId`:

- the banner shows `Filter by owner`
- clicking it rewrites the audit route state so:
  - `page` resets to `1`
  - `q` becomes `sceneOwnerUserId`
  - scene context fields remain intact

This uses the generic free-text audit search because the existing audit backend already supports searching metadata and identifiers via `q`, while no dedicated owner filter exists today.

### Restore scene query

Once owner context is active:

- the banner swaps the owner shortcut for `Restore scene query`
- the restored query prefers:
  - `sceneId`
  - then `sceneName`
- page resets to `1`

This gives the user a reversible pivot between scene-oriented and owner-oriented audit investigation without touching other filters.

### Scope boundary

This slice intentionally does not add a backend-level owner filter. The feature remains a route/query orchestration improvement on top of current audit search semantics.

## Implementation

New helper:

- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditSceneContext.ts`

Responsibilities:

- derive the preferred scene query value
- detect whether owner context is currently active
- build next route state for:
  - switching into owner context
  - restoring the scene query

UI integration:

- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue`

## Files

- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditSceneContext.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmAuditSceneContext.spec.ts`
