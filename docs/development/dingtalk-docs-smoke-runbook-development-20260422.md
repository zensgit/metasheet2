# DingTalk Docs Smoke Runbook Development - 2026-04-22

## Goal

Complete the P4 documentation slice from the DingTalk feature plan:

- administrator guide for app credentials, group robot binding, directory sync, and no-email local user creation
- user workflow guide for group binding, automation messages, public form links, and form access levels
- troubleshooting notes for webhook signature failures, unbound users, missing grants, no-email users, and links that cannot be opened
- remote smoke checklist for deployed environment validation

## Changes

- Updated `docs/dingtalk-admin-operations-guide-20260420.md` with:
  - DingTalk directory account operation flow
  - no-email local user creation and binding notes
  - person delivery `success / failed / skipped` status meanings
  - troubleshooting matrix
- Updated `docs/dingtalk-capability-guide-20260420.md` with:
  - account-list local user creation
  - person delivery skipped status semantics
- Updated `docs/dingtalk-synced-account-local-user-guide-20260420.md` with:
  - manual admission from synced account list
  - no-email create-and-bind behavior
  - troubleshooting for no-created-user, duplicate identifier, pre-bind, and no-email invite cases
- Added `docs/dingtalk-user-workflow-guide-20260422.md`.
- Added `docs/dingtalk-remote-smoke-checklist-20260422.md`.
- Updated `docs/development/dingtalk-feature-plan-and-todo-20260422.md` to reflect completed P3 work and P4 documentation coverage.
- Updated `scripts/ops/export-dingtalk-staging-evidence-packet.mjs` so the exported handoff packet includes the new P4 user guide, account guide, remote smoke checklist, and current plan.

## Non-Goals

- No runtime code changes.
- No API contract changes.
- No database migration changes.
- No live remote smoke execution in this slice; the new checklist is the operator-ready runbook for that execution.

## Expected Effect

Operators and table owners now have a single documented path for:

- binding DingTalk groups to tables
- creating automation messages
- protecting form links with DingTalk and local allowlists
- manually creating and binding no-email DingTalk-synced users
- diagnosing skipped person deliveries
- executing remote smoke without exposing DingTalk secrets or admin tokens
