# Attendance v2.7.2 On-Prem API Base Hotfix

## Problem

`attendance-onprem-run22-20260330` shipped a frontend bundle that embedded `VITE_API_BASE=http://127.0.0.1:7778`.

In production browsers this forced login and all other API calls to the operator's own loopback interface instead of the deployed MetaSheet host, which made the package unusable and required rollback to `v2.7.1`.

## Root Cause

Two independent gaps aligned:

1. `apps/web/src/utils/api.ts` trusted `VITE_API_URL` / `VITE_API_BASE` unconditionally in production.
2. `scripts/ops/attendance-onprem-package-build.sh` defaulted to reusing existing `apps/web/dist` and `packages/core-backend/dist`, so a package build could ship stale artifacts without forcing a fresh build.

Because local development env files contained loopback API settings, a production package could inherit those settings and publish them into the bundle.

## Design

The fix is intentionally small and release-focused:

1. Harden `getApiBase()` in `apps/web/src/utils/api.ts`.
   - If the baked API origin is a loopback host and the browser origin is not loopback, use `window.location.origin`.
   - Keep explicit non-loopback env values untouched.
   - Keep `http://localhost:8900` only as the final no-window fallback.

2. Make Vite env loading overridable.
   - `apps/web/vite.config.ts` now honors `METASHEET_ENV_DIR`.
   - This allows the on-prem packaging flow to build with an isolated empty env directory instead of inheriting developer `.env.local`.

3. Force fresh on-prem package builds.
   - `scripts/ops/attendance-onprem-package-build.sh` now defaults `BUILD_WEB=1` and `BUILD_BACKEND=1`.
   - The web build runs with an isolated temporary env directory.

4. Add a package verify guard.
   - `scripts/ops/attendance-onprem-package-verify.sh` now fails if the built frontend bundle embeds loopback `VITE_API_URL` / `VITE_API_BASE`.

## Scope

Changed files:

- `apps/web/src/utils/api.ts`
- `apps/web/tests/utils/api.test.ts`
- `apps/web/vite.config.ts`
- `scripts/ops/attendance-onprem-package-build.sh`
- `scripts/ops/attendance-onprem-package-verify.sh`

No backend runtime behavior changes were made.
