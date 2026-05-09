# Backend Docker pnpm Pin Verification - 2026-05-08

## Context

The `Build and Push Docker Images` workflow failed on `main` after Corepack resolved pnpm 11 inside the `node:20-slim` backend image.

pnpm 11 requires a newer Node runtime and attempts to load `node:sqlite`, which is unavailable in Node 20. The backend image failed before dependency installation:

```text
warn: This version of pnpm requires at least Node.js v22.13
Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:sqlite
Node.js v20.20.2
```

## Change

`Dockerfile.backend` now pins Corepack to `pnpm@10.16.1` in both build and runner stages.

This matches the repository's known working pnpm 10 line and prevents Corepack from floating to a future pnpm release that is incompatible with the Node 20 image.

## Verification Plan

```bash
docker build -f Dockerfile.backend -t metasheet2-backend:pnpm-pin-smoke .
git diff --check
```

The GitHub `Build and Push Docker Images` workflow should also be green after this branch merges.

## Local Result

`git diff --check` passed.

Local Docker build could not run in this session because the Docker daemon was unavailable:

```text
failed to connect to the docker API at unix:///Users/chouhua/.docker/run/docker.sock
```

Remote GitHub Actions is therefore the authoritative verification for the image build.
