# Verification - Yjs Frontend GHCR Build Flag

- Date: 2026-04-21
- Branch: `codex/yjs-staging-build-flag-20260421`

## Checks

### Dockerfile / Workflow Wiring

Expected:

- `Dockerfile.frontend` defines `ARG VITE_ENABLE_YJS_COLLAB=false`.
- `Dockerfile.frontend` exports the ARG as `ENV VITE_ENABLE_YJS_COLLAB`.
- `.github/workflows/docker-build.yml` passes `--build-arg VITE_ENABLE_YJS_COLLAB=...` to the frontend image build.
- Workflow value defaults to `false` when the repository variable is not set.

### Frontend Build - Yjs Off

Command:

```bash
VITE_ENABLE_YJS_COLLAB=false pnpm --filter @metasheet/web build
```

Result: **PASS**

- Build exited `0`.
- `2354 modules transformed`.
- Output did not include `useYjsDocument-*`, `useYjsTextField-*`, or `yjs-*` chunks, matching the default Yjs-off behavior.

### Frontend Build - Yjs On

Command:

```bash
VITE_ENABLE_YJS_COLLAB=true pnpm --filter @metasheet/web build
```

Result: **PASS**

- Build exited `0`.
- `2354 modules transformed`.
- Output included:
  - `useYjsTextField-D2-i31UE.js`
  - `useYjsDocument-o6U4Xo49.js`
  - `yjs-BoMmO8v_.js`

### Docker Build Smoke

Command:

```bash
docker build -f Dockerfile.frontend \
  --build-arg VITE_ENABLE_YJS_COLLAB=true \
  -t metasheet2-web:yjs-build-flag-smoke .
```

Result: **PASS**

- Docker build completed successfully.
- The containerized frontend build output included the Yjs runtime chunks listed above.

### Focused Frontend Tests

Command:

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-yjs-cell-binding.spec.ts \
  tests/yjs-document-invalidation.spec.ts \
  --reporter=dot
```

Result:

```text
Test Files  2 passed (2)
Tests       7 passed (7)
```

### Typecheck

Command:

```bash
pnpm --filter @metasheet/web exec vue-tsc -b --noEmit
```

Result: **PASS**

### Remote Staging Probe

Observed against `http://142.171.239.56:8081` before this change is deployed:

- `GET /` returns `200`.
- `GET /api/health` returns `200`, `pluginsSummary.failed=0`.
- `GET /api/plugins` returns `200`.
- `GET /api/admin/yjs/status` returns `401` with the expired/manual token. The token provided earlier expired at `2026-04-21T14:08:17Z`.
- Manual `Yjs Staging Validation` workflow run `24728341234` failed because repository secret `YJS_ADMIN_TOKEN` is not set.

This confirms the current deployment is healthy as a general app deployment, but cannot complete Yjs staging E2E until credentials and feature flags are set.
