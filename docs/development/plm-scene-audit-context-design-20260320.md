# PLM Scene Audit Context Design

Date: 2026-03-20
Branch: `codex/plm-workbench-collab-20260312`

## Goal

Strengthen the `recommended scene card -> audit page` flow so the audit page can tell which recommendation context launched it, instead of only receiving generic `sceneId / sceneName / owner`.

## Scope

- Extend audit route state with recommendation metadata.
- Carry recommendation metadata from recommended workbench scene cards into audit routes.
- Show recommendation-aware copy in the audit context banner.
- Keep the change front-end only; do not change federation, backend, or upstream Yuantus behavior.

## Updated Files

- `apps/web/src/views/plm/plmWorkbenchSceneAudit.ts`
- `apps/web/src/views/plmAuditQueryState.ts`
- `apps/web/src/views/plmAuditSceneCopy.ts`
- `apps/web/src/views/PlmAuditView.vue`

## Design

### 1. Audit route state carries recommendation metadata

Added two fields to `PlmAuditRouteState`:

- `sceneRecommendationReason`
- `sceneRecommendationSourceLabel`

These are serialized into route query as:

- `auditSceneReason`
- `auditSceneSource`

This keeps the route shareable and lets audit pages reconstruct recommendation-aware context from the URL alone.

### 2. Recommended scene audit query now preserves source semantics

`buildRecommendedWorkbenchSceneAuditState(...)` now forwards:

- the recommendation reason (`default`, `recent-default`, `recent-update`)
- the scene recommendation source label

This keeps `open-audit` actions distinct without introducing a separate scene-audit route model.

### 3. Audit context banner becomes recommendation-aware

`buildPlmAuditSceneContextBanner(...)` now accepts recommendation metadata and changes copy accordingly:

- current default scene
- recently defaulted scene
- recently updated scene

It also prefers the incoming recommendation source label over the old generic local-context label.

### 4. Audit page state is hydrated end-to-end

`PlmAuditView.vue` now stores the new route fields in refs, includes them in `readCurrentRouteState()`, and restores them in `applyRouteState(...)`.

This keeps browser history, share links, and internal route sync consistent.
