# DingTalk Directory Auto Admission Development

- Date: 2026-04-18
- Worktree: `.worktrees/dingtalk-sync-fix-20260418`
- Branch: `codex/dingtalk-sync-fix-20260418`

## Goal

Allow a directory integration to automatically create and bind local users for synced DingTalk members, but only inside explicitly allowlisted department subtrees.

## Problem

The branch already supported:

- manual review-card admission;
- server-side atomic `admit-user`;
- temporary-password onboarding with forced password change.

But automatic onboarding still stopped at the design stage. Operators could only create users one by one from the review queue even when a department was clearly intended to be auto-admitted.

## Implementation

### Integration policy fields

Backend file:

- `packages/core-backend/src/directory/directory-sync.ts`

Frontend file:

- `apps/web/src/views/DirectoryManagementView.vue`

Changes:

- Extended directory integration config with:
  - `admissionMode`
    - `manual_only`
    - `auto_for_scoped_departments`
  - `admissionDepartmentIds`
- Added normalization/parsing for those fields in create/update/list flows.
- Added directory-admin form controls:
  - admission mode select
  - allowlisted department IDs textarea

### Department-subtree scope matching

Backend file:

- `packages/core-backend/src/directory/directory-sync.ts`

Changes:

- Added subtree-aware scope evaluation so an allowlisted parent department also covers its descendant departments.
- Added explicit eligibility handling for:
  - in-scope members;
  - out-of-scope members;
  - in-scope members missing email.

### Sync-time auto admission

Backend file:

- `packages/core-backend/src/directory/directory-sync.ts`

Changes:

- During `syncDirectoryIntegration()`:
  - keep existing external-identity / email / mobile matching first;
  - only consider auto admission for members that would otherwise remain unmatched;
  - require:
    - `admissionMode = auto_for_scoped_departments`
    - department subtree hit
    - valid email
  - auto-create the local user through the same server-side admission primitive used by manual admission;
  - bind the new user immediately;
  - issue invite ledger records;
  - keep `must_change_password = TRUE` for generated temporary-password users.

### Sync feedback

Backend:

- sync run stats now include:
  - `autoAdmissionCandidateCount`
  - `autoAdmittedCount`
  - `autoAdmissionSkippedMissingEmailCount`
  - `autoAdmissionFailedCount`

Frontend:

- manual sync success messages now surface auto-admission counts when present.
- integration cards and overview chips now display the current admission mode.

## Safety Boundaries

This round intentionally keeps auto admission narrow:

- no global auto-create mode;
- no exclude-department rules yet;
- no automatic role templating yet;
- no outbound DingTalk notification/webhook delivery yet;
- missing-email members stay unmatched and visible for manual handling.
