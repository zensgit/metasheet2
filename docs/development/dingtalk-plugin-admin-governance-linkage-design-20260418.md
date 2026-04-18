# DingTalk Plugin Admin Governance Linkage Design

- Date: 2026-04-18
- Worktree: `.worktrees/dingtalk-member-group-role-sync-20260418`
- Branch: `codex/dingtalk-member-group-role-sync-20260418`

## Question

As a platform product, should ordinary users create organizations? Should
plugins have their own administrators? How should DingTalk synced departments
and projected member groups participate in that model?

## Short Answer

1. Ordinary users should **not** create top-level organizations.
2. Platform admins should create or approve top-level organization / tenant
   onboarding.
3. Organization admins should create users, govern DingTalk sync, and maintain
   member groups.
4. Plugin admins should exist, but only as **namespace-scoped delegated
   administrators**, never as platform-wide admins.
5. DingTalk departments should continue to project into
   `platform_member_groups` instead of creating a second local org tree.

## Why This Model

If ordinary users can create top-level organizations freely, the platform
quickly loses control over:

- tenant sprawl;
- billing boundaries;
- audit ownership;
- DingTalk enterprise binding ownership;
- cross-organization data isolation.

The safer split is:

- **platform / tenant layer**
  - controlled by the platform;
- **organization governance layer**
  - managed by organization admins;
- **plugin governance layer**
  - delegated by namespace and by scope.

## Recommended Governance Layers

### Layer 1: Top-level organization / tenant

Who can create:

- platform admin;
- or a controlled self-service onboarding flow such as “open workspace” /
  “open enterprise space”.

Who cannot create:

- ordinary end users.

Rationale:

- the tenant is the root for data isolation, compliance, and identity
  ownership;
- DingTalk enterprise binding should attach to a controlled tenant, not a
  user-created ad hoc container.

### Layer 2: Organization governance

Managed by:

- organization owner;
- organization admin;
- or delegated platform-approved admin roles.

Capabilities:

- create local users;
- reset passwords;
- review and admit DingTalk synced members;
- configure DingTalk sync scopes;
- create and maintain member groups;
- configure member-group default role and namespace linkage;
- view sync runs, alerts, and audit history.

### Layer 3: Plugin governance

Managed by:

- platform admin, as the grantor of plugin-admin scope;
- plugin admin, as the namespace-scoped operator.

Plugin admin means:

- a user who holds a namespace-specific delegated admin role such as
  `crm_admin`;
- plus an explicit scope restriction:
  - directory department scope;
  - or projected member-group scope.

This means plugin admins do **not** hold global admin power. They only govern:

- users inside their approved scope;
- roles inside their own namespace;
- plugin admissions inside their own namespace.

## DingTalk Linkage

### Keep DingTalk as the upstream directory mirror

The current and recommended model already fits this:

- `directory_departments`
- `directory_accounts`
- `directory_account_links`

That mirror should stay upstream-only.

### Do not build a second local department tree

Instead, project selected DingTalk departments into:

- `platform_member_groups`

Advantages:

- no dual org-tree drift;
- reusable governance anchor for delegated admin scope;
- reusable target for scoped auto-admission;
- reusable target for default role / namespace linkage.

### Plugin admin scope should consume member groups and departments

Recommended scope model:

- platform admins define which member groups or directory departments a plugin
  admin may govern;
- plugin admins can then manage only users inside:
  - their scoped directory departments;
  - or their scoped projected member groups.

This is already aligned with the repository’s delegated admin direction and
should remain the standard instead of inventing a plugin-specific org model.

## Multitable Linkage

The same member-group bridge should also be reused by multitable governance.

Recommended direction:

- DingTalk department subtree
- projected `platform_member_groups`
- plugin-admin scope
- multitable row/column permission subjects

This keeps:

- directory sync,
- plugin governance,
- multitable governance

on one consistent person-group model instead of three disconnected ACL systems.

## Recommended User Creation Model

### Users with email

Preferred path:

- invite link;
- user sets first password on acceptance.

### Users without email

Preferred path:

- administrator issues a temporary password;
- user signs in through a non-email identifier channel;
- user is forced to change password on first interactive login.

Current product gap:

- local user creation still requires `email + name`;
- so “no-email user onboarding” is not yet fully closed.

Recommended follow-up:

- support one non-email login identifier:
  - mobile login;
  - or username / employee code login.

## Plugin Admin Recommendation

### What should be allowed

- assign namespace-specific roles;
- enable / disable namespace admissions;
- manage only users inside delegated department or member-group scope.

### What should not be allowed

- creating top-level organizations;
- unrestricted cross-tenant access;
- unrestricted cross-plugin role assignment;
- silent promotion to platform admin.

## Recommended Rollout Order

1. keep top-level organization creation platform-controlled;
2. let organization admins manage users, DingTalk sync, and member groups;
3. let projected DingTalk departments drive member groups;
4. let member groups feed plugin-admin delegated scopes;
5. only later consider controlled self-service workspace creation.

## Recommendation Summary

For this platform:

- do **not** let ordinary users create organizations;
- do let organization admins create users and governance objects;
- do support plugin admins;
- but only as namespace-scoped delegated admins with department/member-group
  scope;
- and keep DingTalk departments mapped into member groups, not into a second
  local org tree.

## Companion Matrix

For a compact role-by-role and plugin-by-plugin view, see:

- `docs/development/dingtalk-plugin-governance-role-matrix-20260418.md`
