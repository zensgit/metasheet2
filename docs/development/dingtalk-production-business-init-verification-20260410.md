# DingTalk Production Business Initialization Verification

Date: 2026-04-10

## Verified Production State

### DingTalk login baseline

Confirmed before and after initialization:

- production backend health endpoint returned success
- `GET /api/auth/dingtalk/launch` returned `200`
- first real DingTalk identity remained present for `zhouhua@china-yaguang.com`

### Attendance bootstrap row

Verified the new production row:

- `attendance_integrations.id = 1eb4cda9-795e-4a17-9fa8-ea3bef49a643`
- `org_id = default`
- `status = disabled`
- config note explains that `userIds` and `columnIds` still need to be filled before first sync

### Member group seed

Verified the new production member group:

- `platform_member_groups.id = 77ec23b9-0f92-4bb6-a5bb-77ef4d613313`
- contains user `b928b8d9-8881-43d7-a712-842b28870494`

### Scope template seed

Verified the new production scope template:

- `delegated_role_scope_templates.id = 5b1ab4c6-14a0-4537-9e0c-fedf47725e3d`
- linked to the member group above through `delegated_role_scope_template_member_groups`

### Directory sync bootstrap

Verified the new production directory integration:

- `directory_integrations.id = 8b68baf4-526b-477a-8343-c38d9614e2ec`
- `name = Production DingTalk Directory`
- `status = active`
- `corp_id = dingd1f07b3ff4c8042cbc961a6cb783455b`
- `rootDepartmentId = 1`

Verified the first manual run completed successfully:

- `directory_sync_runs.id = 349685f2-fbae-4026-a640-18227564c998`
- `status = completed`
- `departmentsSynced = 1`
- `accountsSynced = 1`
- `unmatchedCount = 1`

Verified the synced directory data currently present in production:

- active departments for this integration: `1`
- active accounts for this integration: `1`
- unmatched links: `1`
- pending links: `0`
- linked links: `0`

Verified the synced account row:

- `external_user_id = 0447654442691174`
- `name = 周华`
- `mobile = 13758875801`
- `email = NULL`
- `is_active = true`

## Counts After Initialization

- `attendance_integrations = 1`
- `directory_integrations = 1`
- `directory_departments = 1` for the production DingTalk integration
- `directory_accounts = 1` for the production DingTalk integration
- `platform_member_groups = 1`
- `delegated_role_scope_templates = 1`
- `delegated_role_admin_scopes = 0`
- `delegated_role_admin_member_groups = 0`

The zero values are expected in this wave because no second real user was available for delegated assignment.

## Remaining Inputs Before Full Business Use

### Attendance

Still required before first real sync:

- real DingTalk attendance `userIds`
- real DingTalk attendance `columnIds`
- target date range for first dry-run / real-run smoke

### Notifications

Still required before first real notification smoke:

- DingTalk robot webhook

### Delegated permissions

Still required before first real delegated-boundary smoke:

- second real non-admin user
- target plugin-admin role to delegate

### Directory linking

Still required before directory-synced members without email can sign in through DingTalk:

- either corporate email on the DingTalk account
- or a manual `user_external_identities` pre-bind using the DingTalk external identifiers

## Operational Residual

The production `docker/app.env` file on disk is still malformed with literal `\\n` separators. Running services are healthy because their container environment is already loaded, but this file should be repaired before the next deploy or env-parsing operation.
