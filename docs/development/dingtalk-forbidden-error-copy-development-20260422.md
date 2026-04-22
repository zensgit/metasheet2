# DingTalk Forbidden Error Copy Development

- Date: 2026-04-22
- Branch: `codex/dingtalk-forbidden-error-copy-20260422`
- Scope: frontend multitable API error handling

## Goal

Make code-only backend `FORBIDDEN` responses readable in the frontend.

After the DingTalk Groups panel was gated by table automation permissions, stale or direct requests can still be denied by the backend. Some table-scoped endpoints return:

```json
{ "ok": false, "error": { "code": "FORBIDDEN" } }
```

Before this slice, `MultitableApiClient` surfaced that as `API 403`. The target behavior is `Insufficient permissions`, matching existing legacy string error envelopes.

## Implementation

- Added a `defaultApiErrorMessage()` helper in `MultitableApiClient`.
- Preserved the existing error priority:
  - first field-level validation error
  - explicit backend `error.message`
  - frontend code fallback
  - generic `API {status}`
- Mapped `FORBIDDEN` without a backend message to `Insufficient permissions`.
- Added fallback copy for `UNAUTHENTICATED` and `VALIDATION_ERROR` while leaving unknown codes on the generic status fallback.
- Added client tests using DingTalk group list requests because that is the current user-facing permission path.
- Added a `MetaApiTokenManager` assertion that a forbidden DingTalk Groups preload shows the readable permission message in the alert.

## Files

- `apps/web/src/multitable/api/client.ts`
- `apps/web/tests/multitable-api-token-manager.spec.ts`
- `apps/web/tests/multitable-client.spec.ts`
- `docs/dingtalk-admin-operations-guide-20260420.md`
- `docs/dingtalk-capability-guide-20260420.md`

## Notes

- This does not change backend authorization.
- This does not change successful DingTalk group binding flows.
- Existing string error envelopes such as `{ "error": "Insufficient permissions" }` remain preserved as-is.
