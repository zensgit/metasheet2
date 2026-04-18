# DingTalk Directory Member Group Projection Development

- Date: 2026-04-18
- Worktree: `.worktrees/dingtalk-sync-fix-20260418`
- Branch: `codex/dingtalk-sync-fix-20260418`

## Goal

Project selected synced DingTalk departments into platform member groups, so the platform can reuse existing member-group governance instead of inventing a second local org tree.

## Problem

The branch already supported:

- manual admission from synced DingTalk users;
- scoped auto-admission for allowlisted departments;
- forced password change for generated temporary-password users;
- exclude-department overrides for auto admission.

But selected departments still had no first-class local governance projection. Operators could sync the DingTalk directory and create users, yet could not automatically keep a `platform_member_group` aligned with a synced department subtree.

## Implementation

### Integration config

Files:

- `packages/core-backend/src/directory/directory-sync.ts`
- `apps/web/src/views/DirectoryManagementView.vue`

Added config fields:

- `memberGroupSyncMode`
  - `disabled`
  - `sync_scoped_departments`
- `memberGroupDepartmentIds`

These fields now round-trip through create, update, and list flows for
directory integrations.

### Projection planning

File:

- `packages/core-backend/src/directory/directory-sync.ts`

Added pure helper:

- `buildDirectoryProjectedMemberGroupPlans(...)`

Behavior:

- one selected DingTalk department maps to one projected platform member group;
- membership is subtree-aware;
- only linked local users are projected;
- the platform member group name uses a human-readable integration + department
  path;
- the platform member group description stores a deterministic sync marker.

### Sync-time member-group maintenance

File:

- `packages/core-backend/src/directory/directory-sync.ts`

Added transactional helper:

- `syncProjectedDepartmentMemberGroupsInTransaction(...)`

Behavior:

- create projected member groups when missing;
- update projected member-group names when the department path changes;
- replace platform member-group membership to match the current linked local
  users inside the selected department subtree;
- keep projected groups even when current membership becomes empty;
- use nullable audit actor fields when the sync is scheduler-triggered.

### Sync stats

Extended sync run stats with:

- `memberGroupsCreatedCount`
- `memberGroupsSyncedCount`
- `memberGroupMembershipsUpdatedCount`

### Directory management UI

File:

- `apps/web/src/views/DirectoryManagementView.vue`

Added UI controls:

- `成员组同步模式`
- `成员组同步部门`

Added UI feedback:

- integration cards now show current member-group sync mode;
- overview chips show current member-group sync mode;
- sync success messages now include projected member-group counts when present.

## Scope Notes

This round intentionally does not yet implement:

- projected group deletion when a department is removed from config;
- role template defaults applied from projected groups;
- DingTalk outbound notification after member-group projection;
- dedicated admin UI for browsing projected groups from the directory page.

## Deployment

No remote deployment was performed in this round.
