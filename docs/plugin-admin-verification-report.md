# Plugin Admin Verification Report

## Commands Run
1. `pnpm --filter @metasheet/core-backend build`
   - Result: success
2. `pnpm --filter @metasheet/web build`
   - Result: success
3. `pnpm --filter @metasheet/core-backend migrate`
   - Result: failed (PostgreSQL auth error for user `metasheet`)
4. Remote API check (via SSH):
   - `GET http://127.0.0.1:8900/api/admin/plugins` returned `404` with an admin token derived from the live JWT secret (before image update).
   - After pulling new images + restart, `GET http://127.0.0.1:8900/api/admin/plugins` returned `200` and `count=11`.
5. `pnpm install`
   - Result: success (updated lockfile resolutions)
6. `pnpm exec tsx packages/openapi/tools/build.ts`
   - Result: success
7. Preprod UI smoke (`/admin/plugins`):
   - Example Plugin toggled Disable → Enable (status updated, registry enabled).
   - Config loaded (`{}`) and saved; UI shows “Saved to database”.

## Notes
- Runtime verification blocked until DB credentials are updated.
- Remote instance is on images without the new admin plugin endpoints.
