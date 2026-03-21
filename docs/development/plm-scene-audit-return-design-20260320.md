# PLM Scene Audit Return Design

Date: 2026-03-20
Branch: `codex/plm-workbench-collab-20260312`

## Goal

Close the loop from `recommended scene card -> audit page -> original PLM workbench scene`.

The audit page already knew which scene recommendation opened it. This slice adds:

- a stable way to return to the original PLM scene
- automatic focus and highlight of the original recommended scene card after returning

## Design

### 1. Carry return path in audit route state

Extended `PlmAuditRouteState` with:

- `returnToPlmPath`

Route serialization now includes:

- `auditReturnTo`

This keeps the return target shareable and resilient across refresh, history replay, and copied audit links.

## 2. Product page forwards the original scene path

`PlmProductView.vue` now passes `route.fullPath` when opening:

- recommended scene audit
- generic workbench audit

This means the audit page receives the exact PLM workbench URL that created the audit transition.

## 3. Audit page exposes a return action

`PlmAuditView.vue` now restores `auditReturnTo` into local state and shows a primary context action:

- `Return to scene`
- `返回原场景`

That action routes directly back to the original PLM workbench path.

## 4. Returned workbench scene auto-focuses the original card

The return path now carries a transient `sceneFocus` query parameter for recommended-scene audit jumps.

The workbench product page:

- reads `sceneFocus`
- passes it into the product panel contract
- lets the panel scroll to and highlight the matching recommended scene card
- clears the transient query parameter after consumption

This keeps the URL clean while making the return flow visibly anchored to the originating scene.

## 5. Team-view audit helpers stay compatible

Manual `PlmAuditRouteState` builders in `plmAuditTeamViewAudit.ts` were updated to include the new field with an empty default so existing audit-only flows keep compiling cleanly.
