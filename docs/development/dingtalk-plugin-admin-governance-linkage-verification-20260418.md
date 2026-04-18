# DingTalk Plugin Admin Governance Linkage Verification

- Date: 2026-04-18
- Worktree: `.worktrees/dingtalk-member-group-role-sync-20260418`
- Branch: `codex/dingtalk-member-group-role-sync-20260418`

## Verification Method

This round is documentation-only, so verification focused on checking that the
new design is consistent with the current codebase and existing governance
docs.

## Commands

```bash
rg -n "ensurePlatformAdmin\\(|/api/admin/users|/api/admin/directory|platform_member_groups|delegated_role_admin_scopes|delegated_role_admin_member_groups|namespace admission|RoleDelegationView" packages/core-backend/src apps/web/src -g "*.{ts,vue}"
sed -n '1,240p' docs/development/plugin-role-delegation-scope-design-20260409.md
sed -n '1,240p' docs/development/platform-member-groups-delegated-scope-design-20260409.md
sed -n '1,260p' docs/development/dingtalk-directory-sync-admission-and-scoped-sync-design-20260418.md
```

## Findings Confirmed

### 1. User / directory governance is admin-only

Current code paths for:

- user creation;
- directory integration management;
- directory admission;
- password reset;
- member-group governance

all sit behind platform-admin checks in backend admin routes.

This matches the design conclusion that ordinary users should not create
top-level organizations or administer directory sync.

### 2. Plugin admin is already modeled as delegated namespace admin

The repository already contains:

- namespace admission controls;
- delegated department scope;
- delegated member-group scope;
- `RoleDelegationView`

This matches the design conclusion that “plugin admin” should remain:

- namespace-scoped;
- range-limited by department/member-group scope;
- not equivalent to platform admin.

### 3. Member groups are the correct DingTalk bridge

Existing and in-flight DingTalk work already uses projected
`platform_member_groups` as the local governance layer.

This matches the design recommendation to avoid creating a second local
department tree.

## Result

The new design document is consistent with:

- the current admin-only user/directory model;
- the delegated plugin-admin model already present in code;
- the DingTalk department-to-member-group projection direction already present
  in design and implementation branches.

## Deployment

No remote deployment was performed in this round.
