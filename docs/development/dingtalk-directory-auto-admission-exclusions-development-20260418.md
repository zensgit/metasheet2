# DingTalk Directory Auto Admission Exclusions Development

- Date: 2026-04-18
- Worktree: `.worktrees/dingtalk-sync-fix-20260418`
- Branch: `codex/dingtalk-sync-fix-20260418`

## Goal

Refine department-scoped auto admission so operators can include a large DingTalk department subtree but explicitly exclude selected child departments from automatic user creation.

## Problem

The branch already supported:

- manual admission from synced DingTalk review cards;
- automatic admission for allowlisted department subtrees;
- forced password change for generated temporary-password users.

But auto admission was still “include only”. If a parent department was allowlisted, all descendants were admitted. Operators had no way to keep a child subtree inside the sync scope while still blocking automatic user creation for that subtree.

## Implementation

### Backend policy model

File:

- `packages/core-backend/src/directory/directory-sync.ts`

Changes:

- Extended directory integration config with `excludeDepartmentIds`.
- Parse, normalize, summarize, create, and update flows now preserve:
  - `admissionMode`
  - `admissionDepartmentIds`
  - `excludeDepartmentIds`

### Eligibility logic

File:

- `packages/core-backend/src/directory/directory-sync.ts`

Changes:

- `evaluateDirectoryAutoAdmissionEligibility(...)` now receives `excludeDepartmentIds`.
- Scope evaluation order is now:
  1. `admissionMode` must be `auto_for_scoped_departments`
  2. user must be inside an included subtree
  3. if user also falls inside an excluded subtree, exclusion wins
  4. email must exist for actual auto admission

Returned eligibility now distinguishes:

- `inScope`
- `missingEmail`
- `excluded`

### Sync stats

File:

- `packages/core-backend/src/directory/directory-sync.ts`

Changes:

- Added `autoAdmissionExcludedCount` to sync run stats.
- Members blocked by `excludeDepartmentIds` are counted separately instead of silently folding into generic “out of scope”.

### Directory management UI

File:

- `apps/web/src/views/DirectoryManagementView.vue`

Changes:

- Added a new textarea:
  - `自动准入排除部门`
- Integration payloads now submit:
  - `excludeDepartmentIds`
- Integration list cards / overview chips now show both:
  - include count
  - exclude count
- Manual sync success feedback now surfaces excluded-member counts when present.

## Scope Notes

This round intentionally does not yet implement:

- role defaults during auto admission;
- member-group projection from DingTalk departments;
- notification/webhook delivery after auto admission;
- time-bounded password rotation policies.

## Deployment

No remote deployment was performed in this round.
