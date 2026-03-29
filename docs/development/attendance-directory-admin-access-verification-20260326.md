# Attendance Mode Directory Admin Access Verification

Date: 2026-03-26

## Scope

Verify that attendance mode no longer blocks platform administrators from entering the DingTalk directory admin surface.

## Local verification

Commands:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/auth-login-routes.test.ts
pnpm --filter @metasheet/web exec vitest run tests/featureFlags.spec.ts tests/app.spec.ts
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/web build
```

Results:

- backend auth route tests: passed (`53`)
- frontend feature/nav tests: passed (`8`)
- backend TypeScript build: passed
- frontend `vue-tsc --noEmit`: passed
- frontend production build: passed

## Assertions covered

- backend auth feature payload includes `platformAdmin=true` for platform admins
- non-admin `/api/auth/me` feature payload keeps `platformAdmin=false`
- attendance-mode feature store allows `/admin/directory` only for platform admins
- attendance-mode shell renders a visible `目录同步` entry for platform admins

## Deployment follow-up

After deployment to the live attendance-focused environment, validate:

1. Admin login still lands on `/attendance`.
2. Top nav shows `目录同步`.
3. Visiting `/admin/directory` no longer redirects back to `/attendance`.
4. A non-admin account still cannot enter `/admin/directory`.

## Live deployment and validation

Target:

- `142.171.239.56`

Deployment actions:

- synced the changed frontend source files and backend auth route to `/home/mainuser/metasheet2`
- synced local frontend `dist/` to `/home/mainuser/metasheet2-web-dist/`
- hot-updated `metasheet-web` static assets with `docker cp`
- built backend image `ghcr.io/local/metasheet2-backend:attendance-directory-20260326`
- tagged it as `ghcr.io/local/metasheet2-backend:current`

Operational note:

- legacy `docker-compose` on the host failed during backend recreate with `KeyError: 'ContainerConfig'`
- recovery was completed by removing the orphaned compose backend container and starting the backend again

Live results:

- backend container image: `sha256:677b1e5e31f7e46a235b33a84019d1c3adf50794d3768d7b0b4a869da5c713a7`
- `http://127.0.0.1:8900/health` returned `ok=true`
- browser validation with a real admin JWT landed on:
  - `http://142.171.239.56:8081/admin/directory`
  - title: `Directory Sync - MetaSheet`
- rendered shell showed both:
  - `考勤`
  - `目录同步`
- directory page content loaded successfully instead of redirecting back to `/attendance`
