# Frontend Docker pnpm Pin Verification - 2026-05-08

## Context

After the backend image pin landed, the `Build and Push Docker Images` workflow advanced to the frontend image and failed for the same Corepack drift class.

`Dockerfile.frontend` enabled Corepack without preparing a repository-compatible pnpm version, so the Node 20 image resolved pnpm 11 and failed before dependency installation:

```text
warn: This version of pnpm requires at least Node.js v22.13
Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:sqlite
Node.js v20.20.2
```

## Change

`Dockerfile.frontend` now pins Corepack to `pnpm@10.16.1`, matching the backend Dockerfile and local workspace pnpm 10 line.

## Verification Plan

```bash
docker build -f Dockerfile.frontend --build-arg VITE_ENABLE_YJS_COLLAB=true -t metasheet2-web:pnpm-pin-smoke .
git diff --check
```

## Local Result

`git diff --check` passed.

Local Docker build could not run in this session because the Docker daemon was unavailable:

```text
failed to connect to the docker API at unix:///Users/chouhua/.docker/run/docker.sock
```

Remote GitHub Actions is therefore the authoritative verification for the image build.
