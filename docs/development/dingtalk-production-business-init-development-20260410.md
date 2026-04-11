# DingTalk Production Business Initialization Development Log

Date: 2026-04-10

## Summary

Executed the first minimal production business initialization after the DingTalk stack rollout.

Result:

- first real production DingTalk admin remained healthy and usable
- one disabled attendance integration placeholder was created
- one production DingTalk directory integration was created and synced once
- one platform member group was created
- one delegated scope template was created and linked to that member group

## Executed Actions

### 1. Reconfirmed live production baseline

Revalidated:

- `users=3`
- `dingtalk_grants=1`
- `dingtalk_identities=1`
- `attendance_integrations=0`
- `member_groups=0`
- `scope_templates=0`
- `delegated_scopes=0`

Verified the three production users were:

- on-prem admin placeholder
- staging admin placeholder
- `zhouhua@china-yaguang.com`

### 2. Attendance integration bootstrap

Inserted one disabled production attendance integration:

- id: `1eb4cda9-795e-4a17-9fa8-ea3bef49a643`
- org: `default`
- name: `Production DingTalk Attendance Bootstrap (Pending Users & Columns)`
- status: `disabled`

Stored config uses the existing production DingTalk credentials and intentionally leaves:

- `userIds=[]`
- `columnIds=[]`

The stored note is:

- `Production bootstrap placeholder. Fill userIds and columnIds before first sync.`

### 3. Platform member group seed

Inserted one platform member group:

- id: `77ec23b9-0f92-4bb6-a5bb-77ef4d613313`
- name: `Production Initial DingTalk Admins`

Added the first real production administrator as the only member:

- `b928b8d9-8881-43d7-a712-842b28870494`

### 4. Delegated scope template seed

Inserted one delegated scope template:

- id: `5b1ab4c6-14a0-4537-9e0c-fedf47725e3d`
- name: `Production Initial DingTalk Admin Scope Template`

Linked the template to the member group above.

No delegated user assignment was created in this wave.

### 5. Directory sync bootstrap

Created one production directory integration by calling the existing backend directory-sync service inside the live backend container:

- id: `8b68baf4-526b-477a-8343-c38d9614e2ec`
- name: `Production DingTalk Directory`
- corpId: `dingd1f07b3ff4c8042cbc961a6cb783455b`
- rootDepartmentId: `1`
- status: `active`
- syncEnabled: `false`

Connectivity test succeeded before the first sync:

- `departmentSampleCount = 0`
- `userSampleCount = 1`
- sampled user:
  - `0447654442691174 / 周华`

Executed one manual sync immediately after creation. The first run completed successfully:

- run id: `349685f2-fbae-4026-a640-18227564c998`
- status: `completed`
- stats:
  - `departmentsSynced = 1`
  - `accountsSynced = 1`
  - `unmatchedCount = 1`
  - `pendingCount = 0`
  - `linkedCount = 0`

The sync stored one directory account for `周华` and currently shows it as `unmatched` because there is no email on the DingTalk account and no pre-bound `user_external_identities` row for that external user.

## Execution Notes

- Production `docker/app.env` is still present on disk in literal `\\n` format even though the currently running containers are healthy. This did not block this initialization because the execution path parsed only the required DingTalk keys, but it remains an operational drift to fix before the next deploy operation.
- The initialization was executed with idempotent lookups by name before insert, so re-running the same bootstrap will not create duplicate seed rows.

## Explicitly Deferred

- live attendance sync execution
- directory-based local-user linking for users without DingTalk email
- robot notification smoke
- second real user bootstrap
- delegated plugin-admin assignment
