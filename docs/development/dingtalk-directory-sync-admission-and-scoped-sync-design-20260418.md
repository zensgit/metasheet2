# DingTalk Directory Sync Admission And Scoped Sync Design

Date: 2026-04-18

## Question

After DingTalk directory data is synced into:

- `directory_departments`
- `directory_accounts`
- `directory_account_links`

how should the platform support:

1. manual or automatic creation of local departments / local users;
2. syncing only a specific department or subtree;
3. controlled admission instead of forcing every synced DingTalk person to
   become a local platform user immediately.

## Current State

The current implementation already supports:

- syncing one DingTalk subtree via `rootDepartmentId`;
- storing synced departments and members in the directory mirror tables;
- manual bind / unbind between a synced DingTalk account and an existing local
  platform user;
- review queues for `pending_binding`, `inactive_linked`, and
  `missing_identifier`.

What it does **not** do yet:

- create a new local platform user directly from a synced DingTalk account;
- mirror DingTalk departments into a first-class local org tree;
- support a scoped allowlist of multiple departments beyond one
  `rootDepartmentId`;
- auto-admit only selected departments into local users / local groups.

Updated branch status:

- manual local-user admission: implemented
- scoped auto-admission with include/exclude departments: implemented
- selected department -> platform member group projection: implemented
- projected member groups -> safe default role/plugin governance linkage: implemented

## Recommendation

Do not make “sync from DingTalk” automatically create all local users by
default.

That is too risky for:

- account explosion;
- accidental privilege spread;
- stale users from the wrong DingTalk subtree;
- hard-to-reverse access growth.

The better model is:

1. keep DingTalk as the upstream directory mirror;
2. add a controlled admission layer on top of the mirror;
3. only auto-create local entities for explicitly scoped departments.

## Recommended Roadmap

### Phase 1: Manual admission from synced DingTalk accounts

Add a new action on review/account cards:

- `创建本地用户并绑定`

Behavior:

1. operator selects a synced DingTalk member;
2. system pre-fills:
   - name
   - email
   - mobile
   - DingTalk identity metadata
3. operator confirms creation;
4. backend creates:
   - `users`
   - `user_external_identities`
   - optional `user_external_auth_grants`
5. the new user is immediately linked through `directory_account_links`.

This is the safest first step because it stays review-driven.

### Phase 2: Department-to-group projection instead of a separate local org tree

For this codebase, a better “local department” target is usually:

- `platform_member_groups`

rather than inventing a second local department tree.

Reason:

- the repository already has member-group governance;
- delegated scope templates already consume synced directory departments and
  member groups;
- many downstream use-cases are really “who belongs to this operational
  cohort”, not “render another full org chart”.

Recommended feature:

- allow an operator to map one synced DingTalk department to one
  `platform_member_group`
- support:
  - create group from department
  - sync group membership from department members
  - choose manual vs scheduled refresh

This gives a practical local governance layer without duplicating the org tree.

It also creates the correct bridge for future plugin governance:

- DingTalk department subtree
- projected platform member group
- delegated plugin-admin scope
- namespace-specific role / admission management

Current branch implementation uses integration config fields instead of a new
table:

- `memberGroupSyncMode`
- `memberGroupDepartmentIds`

Behavior:

- sync creates or updates one projected `platform_member_group` per selected
  department;
- group membership is derived from linked local users inside that department
  subtree;
- projected groups are tracked by a deterministic description marker.
- projected groups can also fill a safe additive governance baseline for linked
  users via:
  - `memberGroupDefaultRoleIds`
  - `memberGroupDefaultNamespaces`

Current safety boundary:

- configured roles must exist;
- `admin` and delegated-admin style roles are rejected;
- configured namespaces must be admission-controlled.

### Phase 3: Scoped auto-admission for selected departments

If auto-creation is needed, gate it behind explicit scope configuration.

Recommended new config per directory integration:

- `admissionMode`
  - `manual_only`
  - `auto_for_scoped_departments`
- `admissionDepartmentIds: string[]`
- `excludeDepartmentIds: string[]`
- `createDingTalkGrantOnAdmission: boolean`
- `defaultRoleOnAdmission: 'user' | ...`
- `syncToMemberGroup: boolean`

Behavior:

- only accounts under allowlisted departments are eligible;
- excluded departments always win over included parents;
- new local users are created only when no existing exact match / binding
  exists;
- all auto-admissions write audit logs and show in sync run stats.

## “Sync only one department” answer

There is already a partial answer today:

- `rootDepartmentId`

If your goal is “only sync one DingTalk department subtree”, you can already
do that by configuring the integration root to that department instead of the
enterprise root.

What is still missing is:

- multiple scoped department allowlists;
- include/exclude combinations;
- separate “mirror the directory” scope from “admit into local users” scope.

## Data / API Proposal

### New admission table

Suggested table:

- `directory_sync_admission_policies`

Fields:

- `integration_id`
- `mode`
- `department_ids`
- `exclude_department_ids`
- `auto_create_users`
- `auto_create_groups`
- `default_role`
- `enable_dingtalk_grant`
- `created_at`
- `updated_at`

### New run stats

Extend sync run stats with:

- `admittedUsers`
- `skippedExistingUsers`
- `skippedOutOfScopeAccounts`
- `createdGroups`
- `updatedGroupMemberships`
- `admissionFailures`

### New UI actions

On the directory review page:

- `创建本地用户并绑定`
- `加入平台用户组`
- `从部门创建平台用户组`
- `仅同步该部门`

On the integration settings page:

- `Admission mode`
- `Admission department scope`
- `Exclude departments`
- `Auto-create users`
- `Auto-sync member groups`

## Rollout Strategy

Recommended order:

1. manual user admission
2. department -> member group projection
3. scoped auto-admission
4. safe default role / namespace linkage for projected member groups

Do **not** ship auto-admission before manual admission and audit visibility are
available.

## Recommendation Summary

If the product goal is practical governance rather than perfect org-tree
mirroring, the best path is:

1. keep DingTalk sync as the source directory mirror;
2. add manual `create local user + bind`;
3. project selected synced departments into `platform_member_groups`;
4. add scoped auto-admission for allowlisted departments only;
5. use projected groups to fill a safe default governance baseline where
   needed.

For plugin governance, this should continue into:

6. namespace-scoped plugin admins whose operative range is delegated by
   department and/or projected member group.

That gives:

- safer user creation,
- less accidental over-sync,
- immediate operational value,
- and a clean path to “auto sync only one department/team”.
