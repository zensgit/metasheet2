# DingTalk Directory Auto Admission And Password Governance Design

- Date: 2026-04-18
- Worktree: `.worktrees/dingtalk-sync-fix-20260418`
- Branch: `codex/dingtalk-sync-fix-20260418`

## Current Capability Status

### Synced DingTalk users -> local platform users

- Manual creation from synced DingTalk members: **supported in this branch**
  - Entry: directory review card `手动创建用户` / `创建用户并绑定`
  - Backend: `POST /api/admin/directory/accounts/:accountId/admit-user`
- Automatic creation for synced users: **supported for allowlisted department subtrees in this branch**
  - Integration config:
    - `admissionMode = auto_for_scoped_departments`
    - `admissionDepartmentIds = [...]`
    - `excludeDepartmentIds = [...]`
  - Only unmatched members in the allowlisted department subtree are auto-created and auto-bound
  - Excluded departments override included parents
  - Current safety rule: account email must exist, otherwise sync leaves the member unmatched
- Sync only one department subtree: **already supported**
  - Integration scope can use `rootDepartmentId`
- Multiple allowlisted departments with automatic admission: **supported**
- Project selected synced departments into platform member groups: **supported in this branch**
  - Integration config:
    - `memberGroupSyncMode = sync_scoped_departments`
    - `memberGroupDepartmentIds = [...]`
  - Each selected department projects to one platform member group containing linked local users from that department subtree
- Apply safe default governance to projected member-group members: **supported in this branch**
  - Integration config:
    - `memberGroupDefaultRoleIds = [...]`
    - `memberGroupDefaultNamespaces = [...]`
  - Sync fills only missing grants for linked local users inside projected groups
  - Current safety rule:
    - ordinary business roles only
    - no `admin`
    - no delegated-admin style roles
    - namespaces must be admission-controlled resources

### Password capabilities

- Admin password reset: **already supported**
  - Route: `POST /api/admin/users/:userId/reset-password`
  - UI: user management page can generate or set a temporary password
- First-time account initialization / first login password setup: **already supported**
  - Invite flow: `/accept-invite`
  - User sets password during invite acceptance instead of using a permanent default password
- Force password change on first interactive login after an admin reset: **supported in this branch**
  - Flag: `users.must_change_password`
  - Forced route: `/force-password-change`
  - Backend: `POST /api/auth/password/change`
  - Admin reset and directory-generated temporary passwords both set the flag
- Scheduled / temporary policy-driven automatic password change window: **not implemented**

## Recommended Roadmap

### Phase 1: keep manual admission as the safe default

This branch already covers the correct first step:

- operator reviews a synced DingTalk member;
- creates a local user deliberately;
- receives onboarding outputs immediately;
- binds the user to the directory account in one backend path.

This should remain the default path until audit visibility and policy controls are mature.

### Phase 2: scoped automatic admission

This branch now implements the safe minimum:

- only allowlisted departments auto-admit;
- excluded child departments override allowlisted parents;
- matching is department-subtree aware;
- existing local users are never duplicated;
- generated local users are bound immediately;
- generated temporary-password users are forced into password change on login;
- sync run stats now expose auto-admission counts.

Still not implemented:

- role templates or member-group projection during admission;
- dedicated operator notification delivery for auto-admitted users.

The branch now also allows projected member groups to add a safe downstream
governance baseline after admission:

- default business roles
- default namespace admissions

This is additive only and intentionally does not revoke grants when a user
later leaves scope.

### Phase 3: password governance

#### 3.1 First-login password change after reset

Implemented in this branch:

- user-level auth flag `must_change_password`
- set to `true` when:
  - admin resets a password
  - directory admission generates a temporary password
- login flow allows sign-in but redirects the user into `/force-password-change`
- API access is restricted by JWT middleware until the flag is cleared
- `/api/auth/password/change` clears the flag and reissues the session token

#### 3.2 Time-bounded password policy

If customers need “enable password rotation for a period of time”, do not schedule blind password replacement.

Safer model:

- policy table, for example `auth_password_policies`
- fields:
  - `enabled_from`
  - `enabled_until`
  - `resetIntervalDays`
  - `forceChangeOnNextLogin`
  - `scope` (`all_users`, `member_group`, `directory_department`)

Policy effect:

- users are not silently assigned unknown passwords;
- instead, the system marks them as requiring password reset / change;
- admins can still trigger one-click reset when needed.

## Recommendation Summary

Recommended near-term order:

1. merge manual admission;
2. add backend-scoped auto-admission policies for selected departments only;
3. expand scoped automatic admission with exclusions, role defaults, and notifications only where needed;
4. only then consider time-bounded password-governance policies.

This keeps DingTalk sync safe while still supporting enterprise onboarding needs.
