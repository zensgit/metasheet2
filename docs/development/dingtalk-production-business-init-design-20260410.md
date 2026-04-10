# DingTalk Production Business Initialization Design

Date: 2026-04-10

## Goal

Complete the first minimal production business initialization after the merged DingTalk stack rollout without changing code, schema, or runtime configuration.

This wave intentionally focuses on:

- one real production DingTalk platform administrator already verified end-to-end
- one disabled attendance integration skeleton that can be completed later
- one platform member group and one delegated scope template as seed data

This wave intentionally does not include:

- a real DingTalk robot notification smoke, because no production webhook was provided
- a second real non-admin production user, because no production email was provided
- a live attendance sync run, because no production `userIds` or `columnIds` were available
- a delegated plugin-admin assignment, because there is no second real user to delegate to

## Current Production Preconditions

- production runs merged DingTalk main tag `810f6639a`
- DingTalk launch endpoint is healthy
- first real DingTalk login for `zhouhua@china-yaguang.com` already succeeded
- `DINGTALK_AUTH_REQUIRE_GRANT=1`
- `DINGTALK_AUTH_AUTO_LINK_EMAIL=1`
- `DINGTALK_AUTH_AUTO_PROVISION=0`

## Initialization Strategy

### 1. Attendance bootstrap by disabled placeholder

Create one disabled `attendance_integrations` row under the default org with:

- `type='dingtalk'`
- known production DingTalk credentials already present on the server
- empty `userIds`
- empty `columnIds`
- a note that the integration is only a bootstrap placeholder

The row remains disabled on purpose so production cannot accidentally run a broken sync before real business inputs are provided.

### 2. Delegated admin seed data without a delegate target

Create one platform member group containing the first real production DingTalk administrator.

Create one delegated scope template linked to that member group only.

Do not create delegated user assignments yet. Without a second real user, any delegated assignment would either be fake or would grant delegation back to the platform administrator, which does not validate the intended boundary.

### 3. No direct runtime impact

All writes are data-only:

- no container restart
- no migration
- no env change
- no route or UI change

## Expected Outcome

After this wave, production should have:

- one real DingTalk platform admin with a live identity binding
- one disabled attendance integration skeleton ready for business completion
- one member group seed
- one scope template seed

Business data still explicitly missing after this wave:

- real attendance `userIds`
- real attendance `columnIds`
- DingTalk robot webhook
- second real non-admin user
- first delegated plugin-admin assignee
