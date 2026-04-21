# DingTalk Group Destination Scope Verification - 2026-04-21

## Scope

This verification note is for the DingTalk automation group destination execution-scope hardening. The expected runtime behavior is:

- current-sheet shared destination: found and delivered
- legacy private destination owned by the rule creator: found and delivered
- cross-sheet destination: treated as not found and the action fails
- legacy private destination owned by another user: treated as not found and the action fails

This branch implements the backend executor hardening and records the verification commands run locally.

## Static Checks

Command:

```bash
git diff -- packages/core-backend/src/multitable/automation-executor.ts packages/core-backend/tests/unit/automation-v1.test.ts docs/development/dingtalk-group-destination-scope-*.md
git diff --check
```

Result:

- executor diff scopes DingTalk group destination lookup by `rule.sheetId` and `rule.createdBy`
- tests assert the scoped SQL predicate and query parameters
- `git diff --check` passed with no whitespace errors

## Targeted Unit Tests

Command:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/automation-v1.test.ts tests/unit/dingtalk-group-destination-service.test.ts --watch=false
```

Result:

- `send_dingtalk_group_message` still succeeds for in-scope destinations
- multiple static destinations and dynamic record destinations still resolve correctly
- a destination from another sheet is excluded by the lookup and reported as not found
- no fetch/webhook call is made for out-of-scope destination IDs
- 2 test files passed, 117 tests passed

## Backend Quality Gates

Command:

```bash
pnpm --filter @metasheet/core-backend build
```

Result:

- targeted backend unit suite passed with the command above
- backend build passed
- no database migration is required for this change

## Manual Scenario Placeholder

If a local database and DingTalk robot mock are available, validate these scenarios before release:

- create sheet A and sheet B
- create DingTalk group destination `dest_a` for sheet A
- create DingTalk group destination `dest_b` for sheet B
- create an automation rule on sheet A referencing `dest_a`; expected delivery succeeds
- update the sheet A rule to reference `dest_b`; expected action fails with destination not found
- create an unscoped legacy destination owned by the rule creator; expected delivery succeeds
- create an unscoped legacy destination owned by another user; expected action fails with destination not found

Expected operational signal:

- failed cross-sheet attempts should produce automation step failure diagnostics
- no DingTalk webhook request should be emitted for filtered destinations
- delivery history should only contain records for actual in-scope send attempts

## Rollout Notes

This is a security boundary hardening change. Release notes should mention that automations can no longer send DingTalk group messages through destinations owned by another sheet. If production has legacy cross-sheet references, they should be migrated to per-sheet shared destinations before enabling the hardened executor behavior.
