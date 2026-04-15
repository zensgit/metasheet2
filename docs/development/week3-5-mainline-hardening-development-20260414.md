# Week 3-5 Mainline Hardening Development

Date: 2026-04-14
Branch: `codex/automation-v1-contracts-202605`

## Scope

This slice does two things:

1. Independently reviews Claude's Week 3 / 4 / 5 completion summary against the current repository state.
2. Fixes the mainline backend compile gaps that remained after those Week 3 / 4 / 5 features landed.

The scope is intentionally limited to backend contracts and route/runtime hardening. It does not touch the unrelated dirty frontend files already present in the worktree.

## Claude Summary Review

Claude's Week 3 / 4 / 5 summary is materially correct against the current local repository state.

Validated against current mainline history:

- `000fbd22b` `feat(public-form): add rate limiter middleware, submission audit, integration tests`
- `71c0d3b6d` `feat(multitable): add API token + webhook V1 — token CRUD, HMAC signing, delivery queue`
- `98e93b9ad` `feat(multitable): add field validation rules engine — required, range, pattern, enum with 81 tests`
- `994191002` `docs: add Week 3/4/5 development & verification report`

The concrete code also matches the summary:

- public-form rate limiting exists in [rate-limiter.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/middleware/rate-limiter.ts:1) and is wired in [univer-meta.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/routes/univer-meta.ts:5058)
- field validation exists in [field-validation.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/multitable/field-validation.ts:1) and [field-validation-engine.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/multitable/field-validation-engine.ts:1)
- API token and webhook V1 exist in:
  - [api-tokens.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/multitable/api-tokens.ts:1)
  - [api-token-service.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/multitable/api-token-service.ts:1)
  - [webhooks.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/multitable/webhooks.ts:1)
  - [webhook-service.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/multitable/webhook-service.ts:1)
  - [webhook-event-bridge.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/multitable/webhook-event-bridge.ts:1)
  - [api-tokens.ts routes](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/routes/api-tokens.ts:1)

The `139`-test claim also matches the targeted Week 3 / 4 / 5 test set:

- `9` rate limiter tests
- `8` public-form flow tests
- `68` field validation unit tests
- `13` field validation integration tests
- `41` API token / webhook tests

## Mainline Hardening Changes

While reviewing the Week 3 / 4 / 5 summary, the current branch still had backend compile gaps outside Claude's written summary. This slice fixes those gaps without reopening the feature scope.

### 1. Comment canonical query aliases

Updated [CommentQueryOptions](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/di/identifiers.ts:165) and [CommentService.getComments()](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/services/CommentService.ts:303) so canonical query aliases are represented in the typed contract:

- `targetId`
- `targetFieldId`

This aligns the service signature with the already-shipped route behavior in [comments.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/routes/comments.ts:120).

### 2. API token auth middleware typing

Updated [api-token-auth.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/middleware/api-token-auth.ts:1) so:

- token validation uses a stable `'reason' in result` narrowing path
- synthetic API-token auth populates `req.user` without the previous unsafe cast path

### 3. Dashboard route helper completion

The current branch already referenced dashboard helper symbols from [univer-meta.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/routes/univer-meta.ts:4193), but the helper definitions were missing in this worktree.

This slice adds the missing dashboard runtime helpers:

- widget schema and serialization
- bucket normalization helpers
- source-row loading with view-filter + computed-field handling
- widget aggregation result building

This keeps the dashboard query path internally consistent with the existing route that was already present in the file.

### 4. Automation scheduler callback typing

Updated [automation-service.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/multitable/automation-service.ts:102) so the scheduler callback returns `Promise<void>` rather than leaking the executor return type into the scheduler contract.

## Files Changed In This Slice

- [packages/core-backend/src/di/identifiers.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/di/identifiers.ts:1)
- [packages/core-backend/src/middleware/api-token-auth.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/middleware/api-token-auth.ts:1)
- [packages/core-backend/src/multitable/automation-service.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/multitable/automation-service.ts:1)
- [packages/core-backend/src/routes/univer-meta.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/routes/univer-meta.ts:1)
- [packages/core-backend/src/services/CommentService.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/services/CommentService.ts:1)

## Notes

- This is a hardening slice, not a new product feature slice.
- I did not modify unrelated dirty files under `apps/web/` that are already present in this worktree.
