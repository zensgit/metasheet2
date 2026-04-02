# PLM Audit Saved View Context Design

Date: 2026-03-19
Branch: `codex/plm-workbench-collab-20260312`
Workspace: `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench`

## Goal

Make local audit saved views explicitly show whether they preserve a `scene query` or `owner context`, instead of burying that information inside the free-form summary string.

## Problem

Saved audit views already persisted:

- `sceneId`
- `sceneName`
- `sceneOwnerUserId`

But the UI only exposed that state through a summary text line. That made it hard to tell at a glance whether a saved view represented:

- an active owner-context audit slice
- an active scene-query audit slice
- a generic saved audit filter

## Design

### 1. Introduce a saved-view summary helper

`/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditSavedViewSummary.ts`

This helper owns two responsibilities:

- `buildPlmAuditSavedViewContextBadge(...)`
  - derives a compact `owner | scene` badge from saved route state
- `buildPlmAuditSavedViewSummary(...)`
  - keeps the existing textual summary logic out of the page component

The context badge reuses the same token semantics as the audit scene token layer, so saved views stay aligned with banner/highlight/input-token behavior.

### 2. Render the badge in saved-view cards

`/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue`

Each saved-view card now renders:

- view name
- context badge when present
- textual summary
- updated timestamp

This gives saved views a quick-scannable context signal without removing the richer summary text.

### 3. Keep storage unchanged

No changes were made to saved-view persistence. The badge is derived from fields already stored in `PlmAuditSavedView.state`.

## Expected Outcome

- Saved views that preserve `owner context` show an explicit owner badge.
- Saved views that preserve `scene query` show an explicit scene badge.
- Generic saved views without scene context remain unchanged.
- Saved-view cards become more scannable without changing storage format.

## Scope

Frontend-only UI/read-model enhancement.

No changes to:

- saved-view storage shape
- backend APIs
- route query contract
- federation or upstream PLM behavior
