# DingTalk Group Multi Destinations Development - 2026-04-20

## Goal

Let a single `send_dingtalk_group_message` automation rule send to multiple configured DingTalk group destinations, while keeping backward compatibility with the existing single `destinationId` payload shape.

## Scope

- Backend action config accepts `destinationIds?: string[]` with legacy `destinationId?: string` fallback.
- Automation executor resolves, validates, deduplicates, and fan-outs one message send across multiple group destinations.
- Delivery history is recorded per destination.
- Automation editors support selecting multiple DingTalk groups in one rule.
- Existing single-destination rules remain valid without migration.

## Backend Changes

- Extended `SendDingTalkGroupMessageConfig` in `packages/core-backend/src/multitable/automation-actions.ts`.
- Updated `executeSendDingTalkGroupMessage` in `packages/core-backend/src/multitable/automation-executor.ts` to:
  - normalize `destinationIds`
  - validate missing/disabled destinations across the whole set
  - send once per resolved destination
  - accumulate success/failure details
  - return aggregate output including `destinationIds`, `destinationNames`, and `sentCount`
- Added a focused unit test for multi-destination fan-out in `packages/core-backend/tests/unit/automation-v1.test.ts`.

## Frontend Changes

- `apps/web/src/multitable/components/MetaAutomationManager.vue`
  - group destination picker now appends destinations instead of replacing one value
  - selected groups render as removable chips
  - save payload emits both `destinationId` and `destinationIds`
- `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue`
  - same multi-destination picker/chip behavior in full rule editor
  - edit/save path normalizes legacy single-destination config into array form
- Updated UI tests in:
  - `apps/web/tests/multitable-automation-manager.spec.ts`
  - `apps/web/tests/multitable-automation-rule-editor.spec.ts`

## Compatibility

- Old rules with only `destinationId` continue to load and execute.
- New rules write both:
  - first destination as `destinationId`
  - full selection as `destinationIds`
- No migration is required.

## Non-Goals

- No destination-sharing model changes.
- No per-destination template variance.
- No batching API; current behavior is one signed DingTalk request per destination.
