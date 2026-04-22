# DingTalk Automation Link Summary Development - 2026-04-21

## Background

Users can configure DingTalk group/person automation messages with a public form link and an internal processing view. The inline and advanced editors already preview those links while editing, but the automation rule list only showed the generic action text after saving.

That made it hard to confirm from the rule card whether a DingTalk message opens the intended form or internal processing view.

## Scope

- Enhance the automation rule card action summary for DingTalk group messages.
- Enhance the automation rule card action summary for DingTalk person messages.
- Keep the change presentation-only; no API or persistence behavior changed.

## Implementation

- Updated `MetaAutomationManager.vue`.
- Added `describeDingTalkActionLinks(actionConfig)` and reused existing `viewSummaryName()`.
- DingTalk action summaries now append configured links:
  - `Public form: <view name>`
  - `Internal processing: <view name>`
- If a link is not configured, the card remains concise and does not append an empty placeholder.

## Tests

- Updated `multitable-automation-manager.spec.ts`.
- Existing V1 multi-action DingTalk group/person list tests now verify the rule card includes:
  - base DingTalk action text
  - public form view name
  - internal processing view name

## Files Changed

- `apps/web/src/multitable/components/MetaAutomationManager.vue`
- `apps/web/tests/multitable-automation-manager.spec.ts`

## Notes

- This PR is stacked on the main-target advanced create manager coverage branch because it extends the same manager test area.
- Dependency install produced tracked `node_modules` symlink changes in plugin/tool workspaces; those artifacts are intentionally excluded from the commit.
