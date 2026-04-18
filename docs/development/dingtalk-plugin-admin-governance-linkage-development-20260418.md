# DingTalk Plugin Admin Governance Linkage Development

- Date: 2026-04-18
- Worktree: `.worktrees/dingtalk-member-group-role-sync-20260418`
- Branch: `codex/dingtalk-member-group-role-sync-20260418`

## Goal

Turn the previously discussed “plugin admin + DingTalk department/member-group
linkage” into a formal repository design artifact, so future implementation can
build on a documented platform model instead of scattered chat guidance.

## Work Completed

### 1. Added a dedicated design document

New file:

- `docs/development/dingtalk-plugin-admin-governance-linkage-design-20260418.md`

The document formalizes:

- why ordinary users should not create top-level organizations;
- why platform admins should own tenant creation;
- why organization admins should own user/sync/member-group governance;
- why plugin admins should be namespace-scoped delegated admins instead of
  platform-wide admins;
- why DingTalk departments should continue to project into
  `platform_member_groups` instead of a second local department tree.

### 2. Connected the design back to current DingTalk sync work

Updated:

- `docs/development/dingtalk-directory-sync-admission-and-scoped-sync-design-20260418.md`

to explicitly mention that projected member groups are the correct anchor for
future plugin-admin scope and organization-governance linkage.

### 3. Connected the design back to the existing delegated-scope model

Updated:

- `docs/development/platform-member-groups-delegated-scope-design-20260409.md`

to make the cross-document relationship clearer:

- platform member groups are not only a generic governance object;
- they are also the intended bridge between DingTalk department projection and
  plugin-admin scope.

## Scope Notes

This round is documentation-only.

It does **not** introduce:

- new routes;
- new database tables;
- new frontend pages;
- new delegated admin behavior.

## Deployment

No remote deployment was performed in this round.
No database migration was added in this round.
