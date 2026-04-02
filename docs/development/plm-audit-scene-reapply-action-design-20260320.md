# PLM Audit Scene Reapply Action Design

Date: 2026-03-20
Branch: `codex/plm-workbench-collab-20260312`

## Goal

Add a dedicated one-click action on the audit scene summary card to reapply the current scene filter.

The existing scene token flow already supported:

- pivoting from scene context to owner context
- restoring scene query from owner context
- clearing local scene context

But the summary card still reused the token's primary action. That meant the summary card could drift toward owner-pivot behavior instead of acting like a stable "return to this scene query" control.

## Design

### 1. Keep token actions unchanged

`plmAuditSceneToken.ts` continues to model the local scene-context pivot actions used by:

- the context banner
- the filter highlight
- the inline search token

This slice does not change those semantics.

## 2. Add a summary-card-only action

`plmAuditSceneSummary.ts` now supports a summary-local action:

- `reapply-scene`

This action is only used by the summary card and does not widen the token action contract.

## 3. Prefer scene reapply when the summary card represents active scene context

The summary card now exposes `reapply-scene` when:

- a scene query value exists, and
- the current card represents scene context directly, or
- the current audit is actively using owner/scene context that can be restored back to the scene query

This covers:

- owner-context summary
- active scene-query summary
- scene-only summary with no owner fallback

The inactive owner-shortcut summary keeps its existing owner-pivot action.

## 4. Route the action directly to scene-query restore

`PlmAuditView.vue` now treats `reapply-scene` as a direct call to `restoreAuditSceneQuery()`.

That keeps the summary-card intent explicit:

- summary card reapply stays summary-local
- token actions still represent context pivots

## Result

The audit summary card is now a stable scene-context recovery affordance instead of a thin mirror of token-primary behavior.
