# PLM Team Scene Audit Context Design

Date: 2026-03-19
Branch: `codex/plm-workbench-collab-20260312`
Workspace: `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench`

## Goal

Carry team-scene recommendation context into the PLM audit page so that a user who jumps from a recommended scene card can understand why they landed in the audit view and which scene triggered the navigation.

## Scope

- Extend audit route state with scene context:
  - `sceneId`
  - `sceneName`
  - `sceneOwnerUserId`
- Preserve that context in:
  - audit deep links generated from recommended scene cards
  - local saved audit views
- Exclude that context from:
  - audit team-view snapshots
  - team-view-derived audit route state

## Design Decisions

### 1. Scene context is route-level context, not an audit filter

The existing audit filters already model actor, action, kind, resource, window, and free-text search. Scene metadata does not narrow the audit query by itself; it explains entry context. Because of that:

- `hasExplicitPlmAuditFilters(...)` continues to ignore scene context
- clearing scene context should not reset the actual audit filters

### 2. Team views remain reusable and context-free

Audit team views are intended to be team-shared reusable snapshots. If a team view captured a one-off recommended-scene origin, reusing the team view would accidentally drag that origin forward. To prevent this:

- `buildPlmAuditTeamViewState(...)` keeps only stable filters
- `buildPlmAuditRouteStateFromTeamView(...)` resets scene context back to defaults

### 3. Local saved views preserve scene context

Local saved views are user-private and can safely preserve the scene context that the user chose to save. This supports reopening a previously investigated recommended scene with the same audit explanation.

### 4. Audit entry CTA should carry context automatically

Recommended scene cards already decide the audit action/resource pair from recommendation reason. The same path now also carries:

- `sceneId`
- `sceneName`
- `sceneOwnerUserId`

This lets the audit page show a context banner immediately without extra network fetches.

## UI Behavior

On `/plm/audit`, when scene context exists:

- show a context banner above the summary cards
- describe whether the user came from:
  - a recommended default-scene card, or
  - a recommended team-scene card
- show scene name / id / owner when available
- provide a `Clear context` action that only clears the three scene context fields from route state

Saved-view summaries also surface scene context so the user can distinguish normal audit snapshots from scene-specific ones.

## Files

- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditQueryState.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/plmWorkbenchSceneAudit.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditSavedViews.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmAuditQueryState.spec.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmAuditSavedViews.spec.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmWorkbenchSceneAudit.spec.ts`
