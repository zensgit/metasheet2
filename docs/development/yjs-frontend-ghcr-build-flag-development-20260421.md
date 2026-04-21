# Yjs Frontend GHCR Build Flag

- Date: 2026-04-21
- Branch: `codex/yjs-staging-build-flag-20260421`
- Scope: allow the GHCR frontend image to be built with Yjs collaboration enabled for staging/internal rollout.

## Problem

The backend Yjs stack can be enabled at runtime with `ENABLE_YJS_COLLAB=true`, but the frontend editor path is guarded by the Vite build-time flag `VITE_ENABLE_YJS_COLLAB`.

The GHCR frontend image was previously built without passing that flag into `Dockerfile.frontend`, so the deployed frontend stayed flag-off even when the backend was prepared for Yjs validation. This blocks staging two-browser/manual validation because the browser bundle never activates the Yjs cell binding path.

## Change

`Dockerfile.frontend` now accepts:

```dockerfile
ARG VITE_ENABLE_YJS_COLLAB=false
ENV VITE_ENABLE_YJS_COLLAB=$VITE_ENABLE_YJS_COLLAB
```

`.github/workflows/docker-build.yml` now passes:

```bash
--build-arg VITE_ENABLE_YJS_COLLAB="${VITE_ENABLE_YJS_COLLAB}"
```

The workflow value comes from repository variable `VITE_ENABLE_YJS_COLLAB`, defaulting to `false`.

## Behavior

- Default push builds remain Yjs-off unless the repo variable is explicitly set.
- Internal staging can opt in by setting repository variable `VITE_ENABLE_YJS_COLLAB=true` before publishing a new GHCR image.
- Runtime backend gating remains separate and still requires `ENABLE_YJS_COLLAB=true` in the server env.

## Rollout Requirements

For a real Yjs staging rollout, both switches must be true:

1. Frontend build-time: repository variable `VITE_ENABLE_YJS_COLLAB=true` before GHCR image build.
2. Backend runtime: remote `docker/app.env` contains `ENABLE_YJS_COLLAB=true`.

The Yjs staging workflow also needs repository secret `YJS_ADMIN_TOKEN` set to a non-expired admin JWT.
