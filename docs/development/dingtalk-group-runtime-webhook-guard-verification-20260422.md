# DingTalk Group Runtime Webhook Guard Verification

- Date: 2026-04-22
- Branch: `codex/dingtalk-group-runtime-webhook-guard-20260422`
- Status: passed local validation

## Commands

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/dingtalk-group-destination-service.test.ts --watch=false
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/automation-v1.test.ts --watch=false
pnpm --filter @metasheet/core-backend build
rg -n "normalizeDingTalkRobotWebhookUrl|normalizeDingTalkRobotSecret|testSend rejects legacy invalid webhook URL without fetch|fails send_dingtalk_group_message for legacy invalid webhook without fetch|validates all DingTalk group webhooks before sending any destination|re-check|re-validate stored webhook" packages/core-backend/src/integrations/dingtalk/robot.ts packages/core-backend/src/multitable/dingtalk-group-destination-service.ts packages/core-backend/src/multitable/automation-executor.ts packages/core-backend/tests/unit/dingtalk-group-destination-service.test.ts packages/core-backend/tests/unit/automation-v1.test.ts docs/dingtalk-admin-operations-guide-20260420.md docs/dingtalk-capability-guide-20260420.md docs/development/dingtalk-group-runtime-webhook-guard-*.md
git diff --check
claude -p --tools Read,Grep,Glob --max-budget-usd 0.75 "Read-only review. Inspect current git diff for DingTalk group runtime webhook guard. Focus on testSend and automation group sends not fetching legacy invalid webhook URLs. Do not modify files. Report concrete blockers only; if none, say no blocking issues."
```

## Expected Coverage

- `testSend` rejects legacy invalid stored webhook URLs before `fetch`.
- `testSend` records failed delivery diagnostics and marks the destination test status as failed.
- Automation group sends reject legacy invalid stored webhook URLs before `fetch`.
- Automation pre-validates all selected destinations before sending any valid destination.
- Existing valid DingTalk group sends still pass.
- Shared robot webhook normalization remains used by create/update and runtime paths.
- Backend TypeScript build passes.

## Results

- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/dingtalk-group-destination-service.test.ts --watch=false`: passed, 1 file and 17 tests.
- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/automation-v1.test.ts --watch=false`: passed, 1 file and 121 tests.
- `pnpm --filter @metasheet/core-backend build`: passed.
- `rg -n "normalizeDingTalkRobotWebhookUrl|normalizeDingTalkRobotSecret|testSend rejects legacy invalid webhook URL without fetch|fails send_dingtalk_group_message for legacy invalid webhook without fetch|validates all DingTalk group webhooks before sending any destination|re-check|re-validate stored webhook" ...`: passed, expected backend/test/doc references found.
- `git diff --check`: passed.
- `claude -p --tools Read,Grep,Glob --max-budget-usd 0.75 ...`: passed as read-only review, no blocking issues reported.

## Claude Code CLI

- Local CLI check: `claude --version`
- Version observed: `2.1.117 (Claude Code)`
- Read-only review was executed with `Read,Grep,Glob` tools.
- Claude reported no blocking issues. It noted a non-blocking clarity risk around a raw webhook fallback in the send loop; that fallback was removed and the automation target test still passed.
