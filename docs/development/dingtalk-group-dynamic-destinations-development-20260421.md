# DingTalk Group Dynamic Destinations Development

- Date: 2026-04-21
- Scope: `send_dingtalk_group_message` dynamic destination fields
- Branch: `codex/dingtalk-group-dynamic-destinations-20260421`

## Goal

Extend DingTalk group-message automation so a rule can resolve destination IDs from record data, not only from statically selected group destinations.

## Why This Slice

Current mainline already supports:

- multiple static DingTalk group destinations
- dynamic DingTalk person recipients
- dynamic DingTalk person member-group recipients

The next gap was on the group side: a rule could fan out to multiple configured DingTalk groups, but only when those groups were chosen statically in the rule editor. This slice closes that runtime and authoring gap with a minimal model:

- store `destinationIdFieldPath` / `destinationIdFieldPaths`
- resolve destination IDs from record data at execution time
- keep static `destinationId` / `destinationIds` fully backward compatible
- add generic field pickers instead of inventing a new field type

## Implementation

### Backend

Updated the group-message action config shape to accept:

- `destinationIdFieldPath`
- `destinationIdFieldPaths`

In the automation executor:

- added record-path normalization for DingTalk destination IDs
- merged static destination IDs with dynamic record-derived destination IDs
- returned clearer validation when dynamic paths resolve no destinations
- included `staticDestinationCount`, `dynamicDestinationCount`, and destination field path metadata in action output

Files:

- `packages/core-backend/src/multitable/automation-actions.ts`
- `packages/core-backend/src/multitable/automation-executor.ts`
- `packages/core-backend/tests/unit/automation-v1.test.ts`

### Frontend

Both automation authoring surfaces now support dynamic group destination fields:

- full rule editor
- inline automation manager

Added:

- freeform `Record group field paths (optional)` input
- generic `Pick group field`
- removable chips for selected dynamic fields
- unknown-field warnings
- summary output that includes dynamic record group fields

Files:

- `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue`
- `apps/web/src/multitable/components/MetaAutomationManager.vue`
- `apps/web/tests/multitable-automation-rule-editor.spec.ts`
- `apps/web/tests/multitable-automation-manager.spec.ts`

## Design Notes

- There is currently no dedicated multitable field type or `refKind` for DingTalk group destinations.
- Because of that, the new picker is intentionally generic and lists sheet fields by ID/name instead of pretending there is a stricter semantic discriminator.
- Static destination selection is unchanged and remains the primary guided path.
- Dynamic destination fields are additive, not a breaking change.

## Migrations

- None

## Deployment Impact

- Runtime/API behavior changes for automation execution and authoring
- No schema change
- No env change
