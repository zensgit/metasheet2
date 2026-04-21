# DingTalk Feature Docs Verification

- Date: 2026-04-20
- Branch: `codex/dingtalk-public-form-allowlist-20260420`

## Verification method

This documentation round was verified by checking each documented feature area against the current code paths and open DingTalk feature branches.

## Code references checked

Management-side DingTalk group UI:

- [apps/web/src/multitable/components/MetaApiTokenManager.vue](/Users/chouhua/Downloads/Github/metasheet2/apps/web/src/multitable/components/MetaApiTokenManager.vue:1)

Automation authoring:

- [apps/web/src/multitable/components/MetaAutomationRuleEditor.vue](/Users/chouhua/Downloads/Github/metasheet2/apps/web/src/multitable/components/MetaAutomationRuleEditor.vue:1)
- [apps/web/src/multitable/components/MetaAutomationManager.vue](/Users/chouhua/Downloads/Github/metasheet2/apps/web/src/multitable/components/MetaAutomationManager.vue:1)

Public form share management:

- [apps/web/src/multitable/components/MetaFormShareManager.vue](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-protected-public-form-20260420/apps/web/src/multitable/components/MetaFormShareManager.vue:1)

Public form runtime page:

- [apps/web/src/views/PublicMultitableFormView.vue](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-protected-public-form-20260420/apps/web/src/views/PublicMultitableFormView.vue:1)

Backend public-form share and gating:

- [packages/core-backend/src/routes/univer-meta.ts](/Users/chouhua/Downloads/Github/metasheet2/.worktrees/dingtalk-protected-public-form-20260420/packages/core-backend/src/routes/univer-meta.ts:1)

## Verified statements

- group destination management exists in the management-side UI
- group and person notification automation actions exist
- public form sharing exists
- protected public-form modes exist in the current branch chain
- protected public-form allowlists for local users/member groups exist in the current branch chain
- internal processing links are still governed by local ACL, not by notification delivery
- current group-destination model is manual webhook registration, not DingTalk group auto-import

## Not verified in this docs-only round

- no new automated tests were needed because this round only added descriptive docs
- no remote deployment was performed in this docs-only round

## Conclusion

The two new docs are aligned with the current DingTalk feature line and with the current protected public-form allowlist implementation branch.
