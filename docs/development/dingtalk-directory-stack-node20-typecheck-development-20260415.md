# DingTalk Directory Stack Node20 Typecheck Development

Date: `2026-04-15`
Branch: `codex/feishu-gap-rc-integration-202605`
PR: `#873`

## Context

After the CI blocker fixes were pushed, `Plugin System Tests / test (20.x)` failed on workspace type checking.

GitHub Actions log:

- `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue(183,25)`
- `TS2322: Type 'unknown' is not assignable to type 'string | number | readonly string[] | null | undefined'`

## Change

Updated [MetaAutomationRuleEditor.vue](/tmp/metasheet2-dingtalk-stack/apps/web/src/multitable/components/MetaAutomationRuleEditor.vue:1) to replace the overly broad `Record<string, unknown>` config type with a typed `DraftActionConfig` shape that matches the fields used by the template:

- `fieldUpdates`
- `targetSheetId`
- `fieldValues`
- `url`
- `method`
- `userId`
- `message`
- `locked`

The change is type-only. No runtime behavior or payload shape was changed.
