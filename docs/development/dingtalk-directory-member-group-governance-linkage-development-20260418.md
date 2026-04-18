# DingTalk Directory Member Group Governance Linkage Development

- Date: 2026-04-18
- Worktree: `.worktrees/dingtalk-member-group-role-sync-20260418`
- Branch: `codex/dingtalk-member-group-role-sync-20260418`

## Goal

Extend DingTalk department-to-member-group projection so projected groups can
also grant a safe default governance baseline to already linked local users.

This round does not attempt full RBAC templating. It only adds two explicit,
operator-configured defaults:

- default business roles
- default namespace admissions

Both are one-way “fill missing grants” operations during sync.

## Problem

The previous branch already supported:

- manual admission from synced DingTalk members;
- scoped auto-admission with include/exclude departments;
- forced password change for temporary-password users;
- projection of selected DingTalk departments into `platform_member_groups`.

But projected member groups still stopped at membership. Operators could keep a
department subtree synchronized as a platform member group, yet they still had
to separately grant downstream business roles or plugin admissions for the
same set of linked users.

That made the projection useful for visibility, but incomplete for real
governance rollout.

## Implementation

### Integration config

Files:

- `packages/core-backend/src/directory/directory-sync.ts`
- `apps/web/src/views/DirectoryManagementView.vue`

Added config fields:

- `memberGroupDefaultRoleIds`
- `memberGroupDefaultNamespaces`

These fields now round-trip through:

- create integration
- update integration
- list/summarize integration
- frontend edit form
- frontend integration test payload

### Governance grant planning

File:

- `packages/core-backend/src/directory/directory-sync.ts`

Added pure helper:

- `buildDirectoryProjectedGovernanceGrantSet(...)`

Behavior:

- dedupe projected linked users across multiple selected departments;
- dedupe configured role IDs;
- dedupe configured namespace admissions.

This helper intentionally keeps planning logic pure so the sync-time DB write
path can stay narrow.

### Config validation

File:

- `packages/core-backend/src/directory/directory-sync.ts`

Added backend validation:

- configured role IDs must exist;
- `admin` and delegated-admin style roles are rejected;
- configured namespaces must be admission-controlled resources.

This keeps the feature in a safe baseline:

- operators can grant ordinary business roles;
- operators cannot use this sync path to mass-grant broad admin power.

### Sync-time governance application

File:

- `packages/core-backend/src/directory/directory-sync.ts`

Added transactional helper:

- `applyDirectoryProjectedMemberGroupGovernanceInTransaction(...)`

Behavior:

- after projected groups and memberships are synchronized, collect all linked
  users in scope;
- bulk insert missing `user_roles` for configured default roles;
- bulk upsert enabled `user_namespace_admissions` for configured namespaces;
- keep the operation additive only:
  - no automatic role removal
  - no automatic namespace admission revocation
- invalidate permission caches for users whose projected governance was touched.

### Sync stats

Extended sync run stats with:

- `memberGroupGovernedUserCount`
- `memberGroupDefaultRoleAssignmentsCount`
- `memberGroupDefaultNamespaceAdmissionsCount`

These counters are reported alongside the existing projected member-group
counts.

### Directory management UI

File:

- `apps/web/src/views/DirectoryManagementView.vue`

Added UI controls:

- `成员组默认业务角色`
- `成员组默认插件开通`

Added UI feedback:

- integration summary label now shows when member-group projection also carries
  default governance;
- sync success message now reports how many projected users received missing
  governance grants, plus counts for role inserts and namespace admissions.

## Scope Notes

This round intentionally does not yet implement:

- automatic revocation when a user leaves the projected department;
- per-group role templates beyond explicit role ID lists;
- default permission-scope templates;
- time-window password policy;
- remote deployment.

## Deployment

No remote deployment was performed in this round.
No database migration was added in this round.
