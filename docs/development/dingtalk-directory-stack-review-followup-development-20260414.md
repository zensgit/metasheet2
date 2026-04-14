# DingTalk Directory Stack Review Follow-Up

## Scope

This follow-up responds to the reviewer risk around schedule observation semantics.

Goal:

- make it explicit in the UI that the schedule card is observational
- reduce the chance that operators misread `manual_only` as proof that automatic sync is already wired

## Change

Updated [DirectoryManagementView.vue](/tmp/metasheet2-dingtalk-stack/apps/web/src/views/DirectoryManagementView.vue:1):

- added `readObservationCaution()`
- render an explicit caution banner below the schedule note whenever the observation state is not `auto_observed`
- keep the copy stronger for enabled-but-not-observed states:
  - `当前卡片只反映配置与已记录执行历史；在出现“已观察到自动执行”前，请不要假定系统已接入自动调度。`

Updated [directoryManagementView.spec.ts](/tmp/metasheet2-dingtalk-stack/apps/web/tests/directoryManagementView.spec.ts:1):

- strengthened the existing mount assertion to check for the explicit caution copy
- added a dedicated `manual_only` test case to verify that the caution is rendered

## Claude Code CLI

Used as a narrow suggestion lane for this turn. It suggested:

- make the UI copy explicit that the card is observational
- add a concrete test around `manual_only`

Implementation and final copy remained local.
