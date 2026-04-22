# DingTalk Group Webhook Validation Development

- Date: 2026-04-22
- Branch: `codex/dingtalk-group-webhook-validation-20260422`
- Scope: DingTalk group destination validation

## Goal

Make DingTalk group destinations a stricter standard feature by preventing generic webhooks from being saved as DingTalk group robot targets.

The expected target is a DingTalk group robot webhook copied from the DingTalk group robot settings. It must use the standard `https://oapi.dingtalk.com/robot/send` endpoint and include an `access_token`.

## Implementation

- Added backend normalization and validation for DingTalk group destination webhooks.
- Required DingTalk group webhook URLs to use:
  - `https:` protocol
  - `oapi.dingtalk.com` host
  - `/robot/send` path
  - non-empty `access_token` query parameter
- Added optional secret normalization and validation:
  - trim whitespace
  - require `SEC...` prefix when a secret is provided
- Updated REST error mapping so validation failures return `400`.
- Added frontend save-time validation with inline error text.
- Disabled save when a new or changed webhook/secret is invalid.
- Preserved legacy edit compatibility:
  - unchanged legacy webhook/secret values are not resubmitted during metadata-only edits
  - backend update validation still runs when webhook/secret fields are changed
- Updated DingTalk docs with the enforced webhook and secret rules.

## Files

- `packages/core-backend/src/multitable/dingtalk-group-destination-service.ts`
- `packages/core-backend/src/routes/api-tokens.ts`
- `packages/core-backend/tests/unit/dingtalk-group-destination-service.test.ts`
- `apps/web/src/multitable/components/MetaApiTokenManager.vue`
- `apps/web/tests/multitable-api-token-manager.spec.ts`
- `docs/dingtalk-admin-operations-guide-20260420.md`
- `docs/dingtalk-capability-guide-20260420.md`

## Notes

- This does not change the DingTalk sending payload or delivery history schema.
- Existing valid DingTalk robot webhooks continue to work.
- Private or proxy DingTalk robot hosts are not supported by this standard validation rule.
