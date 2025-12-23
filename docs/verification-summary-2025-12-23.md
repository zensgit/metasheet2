# Verification Summary (2025-12-23)

## Completed
- Comments RBAC guard verified (unauthenticated requests return 401).
- Approvals + workflow designer auth guards verified (401 on unauthenticated access).
- Approval history route now requires authentication to avoid data exposure.
- OpenAPI updated to reflect approvals history auth + pagination.
- Approvals + workflow RBAC enforcement verified (403/200 paths).
- OpenAPI approvals responses now include 401/403 for RBAC-protected endpoints.
- OpenAPI pagination schema aligned to `items` payload for approvals history.
- Duplicate approvals history handler removed; auth guard still enforced.
- Migration + RBAC seed executed and RBAC integration revalidated.
- Smoke suite rerun via `pnpm verify:smoke:all` with updated artifacts.
- CI smoke workflow trigger pending (workflow pushed to `ci/smoke-verify-workflow`, needs merge to default branch).

## Verification Commands

```bash
pnpm --filter @metasheet/core-backend test:integration -- --filter="Comments RBAC"
pnpm --filter @metasheet/core-backend test:integration -- --filter="Approvals + Workflow auth guards"
```

## Reports
- `docs/verification-comments-rbac-2025-12-23.md`
- `docs/verification-approvals-workflow-auth-2025-12-23.md`
- `docs/verification-approvals-workflow-rbac-2025-12-23.md`
- `docs/verification-approvals-history-route-2025-12-23.md`

## Notes
- Plugin loader error logs during integration tests are expected for failure fixtures and dev plugins.
- Approvals and workflow routes are authenticated but not yet enforced by RBAC permissions.
- Approvals and workflow routes are now enforced by RBAC permissions (tests seeded permissions).

## Follow-ups (Proposed)
- Clean up duplicate approvals history route handlers.
- Consolidate duplicate approvals history route handlers into one source.
