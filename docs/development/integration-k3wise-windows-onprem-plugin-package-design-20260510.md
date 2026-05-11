# Design: Bundle Integration Core in the Windows On-Prem Package

**Date**: 2026-05-10
**Scope**:
- `scripts/ops/multitable-onprem-package-build.sh`
- `scripts/ops/multitable-onprem-package-verify.sh`
- `ops/nginx/multitable-onprem.conf.example`
- `docs/deployment/multitable-windows-onprem-easy-start-20260319.md`
- `docs/deployment/multitable-onprem-package-layout-20260319.md`

---

## 1. Problem

The Windows K3 WISE deployment could open the frontend setup page, but backend
requests returned real 404 responses after login:

```
GET /api/integration/external-systems?kind=erp%3Ak3-wise-webapi  -> 404
GET /api/integration/external-systems?kind=erp%3Ak3-wise-sqlserver -> 404
GET /api/integration/staging/descriptors -> 404
```

The frontend route was shipped, but the backend plugin that owns
`/api/integration/*` was not in the on-prem package.

## 2. Route Owner

`plugins/plugin-integration-core/index.cjs` activates the integration runtime
and calls `registerIntegrationRoutes()`.

`plugins/plugin-integration-core/lib/http-routes.cjs` registers the routes used
by the K3 WISE setup page, including:

```
GET  /api/integration/external-systems
POST /api/integration/external-systems
GET  /api/integration/staging/descriptors
POST /api/integration/staging/install
```

The core backend plugin loader scans `./plugins`, so packaging
`plugins/plugin-integration-core` is the correct runtime fix.

## 3. Change

The multitable on-prem package now includes:

```
plugins/plugin-integration-core
```

Package metadata now reports:

```
includedPlugins: ["plugin-attendance", "plugin-integration-core"]
```

Package verification now fails unless these runtime files are present:

```
plugins/plugin-integration-core/plugin.json
plugins/plugin-integration-core/index.cjs
plugins/plugin-integration-core/lib/http-routes.cjs
plugins/plugin-integration-core/lib/adapters/k3-wise-webapi-adapter.cjs
plugins/plugin-integration-core/lib/adapters/k3-wise-sqlserver-channel.cjs
```

The K3 WISE operator-tool comment and generated `INSTALL.txt` were updated so
the package no longer claims the integration plugin is absent.

## 4. Related Field Feedback

The same field pass also surfaced two deployment polish items:

- WebSocket reverse proxy config should match the现场 long-lived upgrade
  recipe. The nginx template already had the `Upgrade`/`Connection` headers; it
  now also uses long socket read/send timeouts.
- The package intentionally excludes `node_modules`. The deployment docs now
  state that `deploy.bat` defaults to `InstallDeps=1` and runs
  `pnpm install --frozen-lockfile` when needed. Manual file-copy deployments
  must run the same command before migrations, restart, or bootstrap.

## 5. Non-Goals

- No K3 WISE adapter behavior change.
- No database schema change beyond the already-packaged SQL migrations.
- No frontend route change. The K3 WISE page was already present; the missing
  backend route owner was the blocker.
