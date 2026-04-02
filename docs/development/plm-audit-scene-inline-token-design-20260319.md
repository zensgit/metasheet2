# PLM Audit Scene Inline Token Design

Date: 2026-03-19
Branch: `codex/plm-workbench-collab-20260312`
Workspace: `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench`

## Goal

Expose the active `scene / owner` context directly beside the audit search field instead of relying only on summary-card color and the scene banner.

## Problem

The previous iteration highlighted:

- the scene-aware summary card
- the filter area
- the search field container

But the search input still did not explicitly state what was currently driving `q`. The user had to infer that from color and surrounding UI.

## Design

### Inline token model

Reuse the same summary-card state as the source of truth and project its active state into the filter row.

When scene context is active:

- show a compact inline token above the search input
- mirror the active summary state
- surface:
  - label
  - active value
  - description
  - contextual action

### Active states

- `owner` context:
  - token highlights owner-driven query state
  - action restores the original scene query
- `scene` context:
  - token highlights scene-driven query state
  - action can pivot to owner query when owner metadata exists

### Visual behavior

- active search field keeps the current blue highlight
- inline token adds explicit textual context instead of only color-based indication

## Scope

This slice stays front-end only:

- no backend change
- no federation change
- no audit API contract change

## Files

- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditSceneContext.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditSceneSummary.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmAuditSceneContext.spec.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmAuditSceneSummary.spec.ts`
