# Send Email Automation Action Constraint Migration — Development

Date: 2026-05-08
Branch: `codex/send-email-automation-action-migration-20260508`

## Context

The RC staging remote verification harness exposed a mainline defect, not a staging drift issue. The application layer accepts `send_email` automation actions, but the PostgreSQL `automation_rules.chk_automation_action_type` constraint was last widened before `send_email` existed.

Observed failure path:

1. Route parsing accepts an automation rule with `actionType='send_email'`.
2. The service-level action allowlist includes `send_email`.
3. Insert into `automation_rules` reaches PostgreSQL.
4. `chk_automation_action_type` rejects the row because the constraint still excludes `send_email`.
5. The request fails as a server error and blocks the RC automation send_email smoke.

## Root Cause

`feat(multitable): add send email automation action` added JavaScript/TypeScript support for the action, executor handling, and frontend wiring. It did not add a follow-up migration to widen the database CHECK constraint.

The prior action widening migration, `zzzz20260419213000_add_dingtalk_person_message_automation_action.ts`, allows:

- `notify`
- `update_field`
- `update_record`
- `create_record`
- `send_webhook`
- `send_notification`
- `send_dingtalk_group_message`
- `send_dingtalk_person_message`
- `lock_record`

It does not include `send_email`.

## Change

Added `zzzz20260508120000_add_send_email_automation_action.ts`.

The migration replaces `chk_automation_action_type` with a widened action list that includes `send_email` while preserving all existing legacy and DingTalk action values.

The rollback path restores the previous constraint list without `send_email`.

## Test Design

Added `send-email-automation-action-migration.test.ts`.

The test deliberately validates the migration constants against the app-level `ALL_ACTION_TYPES` list. This prevents a repeat of the same class of bug where a new action is supported by application code but not by the database constraint.

The test also asserts legacy actions remain present. Those values are still accepted by `automation_rules` even though newer V1 action helpers expose a narrower typed action list.

## Rollout Notes

This is a bugfix-only migration. It does not change executor behavior, notification behavior, or the RC staging harness.

Required deployment sequence:

1. Merge this PR.
2. Deploy the new main build to staging/142.
3. Run migrations.
4. Re-run `pnpm verify:multitable-rc:staging` with a valid staging admin token.
5. Treat `7/7 pass` as the RC GO signal; any failure remains in bugfix-only mode.
