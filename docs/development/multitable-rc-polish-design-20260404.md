# Multitable RC Polish Design

Date: 2026-04-04

## Goal

Use the current stable multitable platform baseline to improve release engineering instead of adding more feature surface.

This slice focuses on two operator-facing gaps:

1. A fixed server-side deploy entrypoint that can apply the next package archive without keeping a long SSH session alive through the whole upgrade.
2. A customer-facing RC summary that explains what stabilized from `run2` through `run10`.

## Scope

### Deployment automation

- Add `scripts/ops/multitable-onprem-apply-package.sh`.
- Update `scripts/ops/multitable-onprem-package-build.sh` so packaged roots include:
  - `deploy.bat`
  - `deploy-remote.bat`
  - `deploy-<run>.bat`
- Update package verification to require the new apply helper and wrappers.
- Update multitable on-prem deployment docs to show the new one-command apply path.

### Release notes / changelog

- Add a customer-facing RC notes document under `docs/deployment`.
- Summarize the platform progression from `run2` through `run10`.
- Keep the document package-safe by avoiding external GitHub links.

## Non-goals

- No changes to approval-center implementation.
- No new attendance business logic.
- No new backend routes or database migrations.

## Design notes

### Package apply helper

The helper accepts a `.zip` or `.tgz`, extracts it into a temporary directory under the deploy root, copies the package contents into the current deploy root, and then delegates to `multitable-onprem-package-upgrade.sh`.

It keeps `docker/app.env` outside the package archive contract and reuses the current server-side env file.

### Windows wrappers

The packaged root wrappers provide two modes:

- `deploy.bat`: foreground execution
- `deploy-remote.bat`: detached background execution with log output under `output/logs/deploy-remote.log`

This mirrors the earlier attendance packaging pattern for remote PM2 startup.
