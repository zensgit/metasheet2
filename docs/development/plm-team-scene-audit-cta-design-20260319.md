# PLM Team Scene Audit CTA Design (2026-03-19)

## Goal
Upgrade the recommended team-scene card secondary action from a generic copy-link action into a context-aware audit entry.

## Scope
- Keep the primary action focused on applying the recommended workbench scene.
- Turn the secondary action into a route-driven audit CTA.
- Reuse the existing PLM audit query model instead of introducing a scene-specific audit page.

## Design
- Add a pure helper at `apps/web/src/views/plm/plmWorkbenchSceneAudit.ts`.
- Map recommendation reasons to audit filters:
  - `default` -> `workbench + set-default + plm-team-view-default + q=scene.id`
  - `recent-default` -> `workbench + set-default + plm-team-view-default + q=scene.id`
  - `recent-update` -> `workbench + q=scene.id`
- Expose `openRecommendedWorkbenchSceneAudit(scene)` through the product panel contract.
- Keep the generic header action `openWorkbenchSceneAudit()` as the broad audit entry.

## Expected UX
- Current default scene cards open default-change audit logs.
- Recent default scene cards open recent default-change audit logs.
- Recent update scene cards open workbench audit logs scoped to that scene.
