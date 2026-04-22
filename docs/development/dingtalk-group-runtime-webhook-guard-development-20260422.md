# DingTalk Group Runtime Webhook Guard Development

- Date: 2026-04-22
- Branch: `codex/dingtalk-group-runtime-webhook-guard-20260422`
- Scope: DingTalk group runtime delivery guard

## Goal

Close the runtime gap for DingTalk group destinations.

The previous slice enforced standard DingTalk robot webhook URLs during create/update. This slice also validates stored webhook URLs before manual test sends and automation sends, so legacy non-DingTalk URLs cannot be used as outbound targets.

## Implementation

- Moved DingTalk robot webhook normalization into the shared DingTalk robot integration module.
- Reused the same standard webhook rules across write-time and runtime paths:
  - `https:` protocol
  - `oapi.dingtalk.com` host
  - `/robot/send` path
  - non-empty `access_token`
  - optional `SEC...` signed robot secret
- Updated `DingTalkGroupDestinationService.testSend` to validate the stored webhook inside the existing failure-handling path before `fetch`.
- Updated automation group-message execution to pre-validate all selected destinations before any outbound send.
- When any selected destination has an invalid legacy webhook, automation fails before sending to any destination and records failed delivery diagnostics for the invalid destinations.
- Updated DingTalk docs to clarify that test sends and automation sends re-check stored webhook URLs.

## Files

- `packages/core-backend/src/integrations/dingtalk/robot.ts`
- `packages/core-backend/src/multitable/dingtalk-group-destination-service.ts`
- `packages/core-backend/src/multitable/automation-executor.ts`
- `packages/core-backend/tests/unit/dingtalk-group-destination-service.test.ts`
- `packages/core-backend/tests/unit/automation-v1.test.ts`
- `docs/dingtalk-admin-operations-guide-20260420.md`
- `docs/dingtalk-capability-guide-20260420.md`

## Notes

- No database migration or payload schema changed.
- Valid DingTalk robot destinations continue to send normally.
- Legacy invalid destinations can still be renamed in the manager from the previous slice, but cannot test-send or automation-send until the webhook is corrected.
