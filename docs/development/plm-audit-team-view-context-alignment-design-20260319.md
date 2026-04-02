# PLM Audit Team View Context Alignment Design

Date: 2026-03-19
Branch: `codex/plm-workbench-collab-20260312`
Workspace: `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench`

## Goal

Align `team views` with the same `scene/owner` context semantics already exposed on:

- audit banner
- summary/filter highlight
- search input token
- local saved views

without changing the fact that audit team views only persist route filters and do not persist scene context fields.

## Problem

Local saved views already showed:

- scene/owner context badges
- context-specific quick actions

But the audit `team views` section still looked context-agnostic, which could mislead users into thinking the currently visible scene/owner context would be saved to or restored from a team view.

## Design

### 1. Add a dedicated team-view context helper

`/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditTeamViewContext.ts`

This helper maps the current `PlmAuditSceneToken` into a team-view note model:

- `kind`
- `label`
- `value`
- `description`
- `localOnly`
- `active`
- `actions`

The key semantic difference is explicit:

- current scene/owner context is local to the current audit session
- team views still only persist route-filter snapshots

### 2. Render the note in the team-view section

`/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue`

The team-view section now shows a local-context block beneath the team-view action row whenever scene context exists. It reuses the same `owner / scene / clear` token actions, but frames them as local pivots before saving/applying team views.

## Expected Outcome

- Users can see that current scene/owner context is local, not part of shared team-view persistence.
- Team-view and saved-view surfaces now speak the same context language.
- Users can still pivot local context from the team-view section without misreading shared persistence behavior.

## Scope

Frontend only.

No changes to:

- audit team-view storage shape
- route-state contract
- backend APIs
