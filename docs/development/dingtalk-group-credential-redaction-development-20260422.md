# DingTalk Group Credential Redaction Development

- Date: 2026-04-22
- Branch: `codex/dingtalk-group-credential-redaction-20260422`
- Scope: DingTalk group destination API/UI credential hygiene

## Goal

Prevent saved DingTalk group robot credentials from being reflected back to the browser after creation.

Robot webhook `access_token` values and optional `SEC...` secrets are delivery credentials. Runtime delivery still needs the stored values, but management UI list/edit responses should not expose them.

## Implementation

- Added a DingTalk group destination API response serializer.
- The serializer:
  - masks `access_token`, `timestamp`, and `sign` query parameters in `webhookUrl`
  - omits the saved `secret` field from API responses
  - exposes `hasSecret` so the UI can show and preserve signed-robot state without revealing the secret
- Applied the serializer to DingTalk group list/create/update API responses.
- Extended frontend DingTalk group destination types with `hasSecret`.
- Updated the DingTalk Groups manager UI:
  - card metadata shows whether a secret is configured
  - editing no longer pre-fills a saved secret
  - leaving the secret field blank keeps the existing secret
  - entering a new `SEC...` value replaces it
  - checking `Clear saved SEC secret` sends `secret: ''`
- Updated operating/capability docs to describe the redaction behavior.

## Files

- `packages/core-backend/src/multitable/dingtalk-group-destination-response.ts`
- `packages/core-backend/src/routes/api-tokens.ts`
- `packages/core-backend/src/multitable/dingtalk-group-destinations.ts`
- `packages/core-backend/tests/unit/dingtalk-group-destination-response.test.ts`
- `apps/web/src/multitable/components/MetaApiTokenManager.vue`
- `apps/web/src/multitable/types.ts`
- `apps/web/tests/multitable-api-token-manager.spec.ts`
- `docs/dingtalk-admin-operations-guide-20260420.md`
- `docs/dingtalk-capability-guide-20260420.md`

## Notes

- No database migration is required.
- Runtime automation delivery and manual test sends still use the raw DB values internally.
- This slice does not change generic webhook management; it is scoped to DingTalk group robot destinations.
