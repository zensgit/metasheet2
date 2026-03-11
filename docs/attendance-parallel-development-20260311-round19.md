# Attendance Parallel Development Report (Round19, 2026-03-11)

## Scope

Round19 accelerated parallel delivery with three concurrent tracks on top of `main`:

1. gate contract hardening unblock path (narrow PR for #404 conflicts).
2. web shell guard + feature-override safety hardening.
3. attendance admin runtime error localization consistency.

## Parallel Delivery Matrix

| Track | PR | Scope | Status |
|---|---|---|---|
| A (Gate contract) | [#414](https://github.com/zensgit/metasheet2/pull/414) | locale dashboard contract hardening + openapi contract lane restoration | CI PASS, waiting approval |
| B (Web guard) | [#415](https://github.com/zensgit/metasheet2/pull/415) | feature override production hardening + plm-focused route containment | CI PASS, waiting approval |
| C (Attendance i18n) | [#416](https://github.com/zensgit/metasheet2/pull/416) | leave/overtime admin runtime error localization and status-path unification | CI PASS, waiting approval |

## Implementation Summary

### 1) PR #414 `fix(attendance-gates): harden locale dashboard contract + cleanup gate checks`

- Branch: `codex/attendance-contract-narrow-main-20260311`
- Commits:
  - `443847c81f6604335f3e543dc8a519d1b00338d6`
  - `e59166f560116e4340fcd30133e4bdf7d4179147`
- Result: all required contract checks green.

### 2) PR #415 `fix(web): harden attendance/plm mode routing and feature override safety`

- Branch: `codex/attendance-web-guard-mainline-20260311`
- Commit:
  - `4229c88711da064c29c6ac81574bf9470a55f2db`
- Changes:
  - `apps/web/src/stores/featureFlags.ts`
    - disallow localStorage feature override in production unless `VITE_ALLOW_FEATURE_OVERRIDE=true`.
    - support `plm-workbench` mode normalization and home-path resolution.
  - `apps/web/src/main.ts`
    - simplify feature-flag loading in route guard.
    - enforce plm-focused route containment to `/plm`.
- Local verification:
  - `pnpm --filter @metasheet/web build` PASS.
  - `pnpm --filter @metasheet/web exec vitest run --watch=false tests/useAuth.spec.ts tests/utils/api.test.ts` PASS.

### 3) PR #416 `fix(attendance): localize leave and overtime admin runtime errors`

- Branch: `fix/attendance-admin-error-localization`
- Commit:
  - `44cb43d36a4ca45c52cd7a8b9c101a86e36ecf70`
- File changed:
  - `apps/web/src/views/AttendanceView.vue`
- Changes:
  - replaced remaining hardcoded English runtime errors in leave/overtime admin flows with `tr(...)` fallbacks.
  - switched affected throw paths to `createApiError(...)` / `createForbiddenError()`.
  - unified catch status handling to `setStatusFromError(..., 'admin')` for consistent localized display.
- Verification:
  - `pnpm --filter @metasheet/web build` PASS.

## CI Evidence (Latest Green)

### PR #414

- `contracts (strict)` SUCCESS
  - https://github.com/zensgit/metasheet2/actions/runs/22932464014/job/66556785181
- `contracts (dashboard)` SUCCESS
  - https://github.com/zensgit/metasheet2/actions/runs/22932464014/job/66556785172
- `contracts (openapi)` SUCCESS
  - https://github.com/zensgit/metasheet2/actions/runs/22932464014/job/66556785173
- `pr-validate` SUCCESS
  - https://github.com/zensgit/metasheet2/actions/runs/22932464001/job/66556785103

### PR #415

- `contracts (strict)` SUCCESS
  - https://github.com/zensgit/metasheet2/actions/runs/22932742105/job/66557622914
- `contracts (dashboard)` SUCCESS
  - https://github.com/zensgit/metasheet2/actions/runs/22932742105/job/66557622913
- `contracts (openapi)` SUCCESS
  - https://github.com/zensgit/metasheet2/actions/runs/22932742105/job/66557622923
- `pr-validate` SUCCESS
  - https://github.com/zensgit/metasheet2/actions/runs/22932742090/job/66557622730
- `e2e` SUCCESS
  - https://github.com/zensgit/metasheet2/actions/runs/22932742115/job/66557622827
- `Plugin System Tests` SUCCESS (Node 18/20 + coverage)
  - https://github.com/zensgit/metasheet2/actions/runs/22932742107/job/66557622767
  - https://github.com/zensgit/metasheet2/actions/runs/22932742107/job/66557622787
  - https://github.com/zensgit/metasheet2/actions/runs/22932742107/job/66557740840

### PR #416

- `contracts (strict)` SUCCESS
  - https://github.com/zensgit/metasheet2/actions/runs/22932944793/job/66558214713
- `contracts (dashboard)` SUCCESS
  - https://github.com/zensgit/metasheet2/actions/runs/22932944793/job/66558214699
- `contracts (openapi)` SUCCESS
  - https://github.com/zensgit/metasheet2/actions/runs/22932944793/job/66558214700
- `pr-validate` SUCCESS
  - https://github.com/zensgit/metasheet2/actions/runs/22932944759/job/66558214687
- `e2e` SUCCESS
  - https://github.com/zensgit/metasheet2/actions/runs/22932944764/job/66558214658
- `Plugin System Tests` SUCCESS (Node 18/20 + coverage)
  - https://github.com/zensgit/metasheet2/actions/runs/22932944814/job/66558214702
  - https://github.com/zensgit/metasheet2/actions/runs/22932944814/job/66558214689
  - https://github.com/zensgit/metasheet2/actions/runs/22932944814/job/66558329759

## Current Blocker

- All three PRs are `MERGEABLE` from checks perspective but `BLOCKED` by branch policy (`reviewDecision=REVIEW_REQUIRED`).
- Repository currently has only one write collaborator visible (`zensgit`), so self-approval is not possible.

## Immediate Merge Plan

1. Add one additional writer/reviewer account, approve #414/#415/#416, then squash-merge in sequence `#414 -> #415 -> #416`.
2. Or temporarily reduce `required_approving_review_count` to `0`, merge the three PRs, then restore to `1`.
3. After merge, run one mainline regression batch:
   - Attendance Gate Contract Matrix
   - Attendance Daily Gate Dashboard
   - Locale zh smoke
   - Strict gates twice

## Notes

- This round intentionally avoided large conflict-heavy merges from #404 and delivered narrow, compile-safe, independently verifiable PRs.
