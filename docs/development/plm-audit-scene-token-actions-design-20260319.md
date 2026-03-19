# PLM Audit Scene Token Actions Design

Date: 2026-03-19
Branch: `codex/plm-workbench-collab-20260312`
Workspace: `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench`

## Goal

Unify the `scene context` action semantics on `/plm/audit` so banner actions, filter-highlight actions, and summary-card actions all derive from one token-level model instead of duplicating `owner / scene / clear` branching in the page view.

## Problem

Before this slice:

- `PlmAuditView.vue` rendered banner actions with inline `v-if / v-else-if` logic.
- The filter-highlight row used a different single-action branch.
- The summary card derived its own action intent separately.

That created three risks:

1. `Filter by owner`, `Restore scene query`, and `Clear context` could drift in availability or wording.
2. The active scene token state was expressed differently between banner and filter highlight.
3. Future scene-context actions would require changing multiple page-level branches.

## Design

### 1. Introduce a single token helper

`/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditSceneToken.ts`

This helper now owns:

- token kind: `owner | scene`
- token label/value/description
- token active state
- action list with stable kinds:
  - `owner`
  - `scene`
  - `clear`

### 2. Let summary cards consume token semantics

`/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditSceneSummary.ts`

The summary card now maps from the token helper instead of rebuilding its own branching. It keeps only the primary, non-clear action so the summary UI stays compact.

### 3. Let banner and filter-highlight rows consume the same token actions

`/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue`

The page now computes one `auditSceneToken` and uses:

- `auditSceneToken.actions` for the banner action row
- `auditSceneToken.actions` for the active filter-highlight row
- a shared handler to execute `owner / scene / clear`

This means the page no longer decides action availability independently in multiple places.

## Expected Outcome

- `owner` context always exposes:
  - `Restore scene query`
  - `Clear context`
- active `scene` context always exposes:
  - `Filter by owner` when owner exists
  - `Clear context`
- inactive shortcut tokens still expose appropriate pivot actions
- summary-card actions remain aligned with token semantics

## Scope

Frontend only.

No changes to:

- federation routes
- backend audit APIs
- `Yuantus` integration
- audit data contracts
