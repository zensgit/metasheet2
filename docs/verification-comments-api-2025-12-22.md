# Verification Report: Comments API (2025-12-22)

## Scope
- Create/list/resolve comment endpoints under `/api/comments`.
- Pagination + resolved filter (`limit/offset/resolved`).
- RBAC enforcement with dev-token flow in integration tests.

## Commands Run
```bash
pnpm --filter @metasheet/core-backend test:integration -- --filter=comments
```

## Results
- ✅ Integration tests passed (12 files / 66 tests).
- ✅ Comments API test passed (create/list/resolve, pagination, resolved filter, mentions parsing).

## Notes
- Integration logs include expected plugin permission warnings and BPMN table warnings.
- Tests obtain a dev token via `/api/auth/dev-token` to satisfy JWT middleware.
- RBAC is bypassed during the integration test (`RBAC_BYPASS=true`).

## Relevant Files
- `packages/core-backend/src/routes/comments.ts`
- `packages/core-backend/src/services/CommentService.ts`
- `packages/core-backend/tests/integration/comments.api.test.ts`
- `packages/openapi/src/openapi.yml`
- `docs/PHASE2_DEV_STATUS.md`
