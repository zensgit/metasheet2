# DingTalk Staging Evidence Packet Development 2026-04-21

## Context

The Yjs rollout path already has a packet exporter that copies its checklist,
runbook, scripts, and signoff helpers into one handoff directory. The DingTalk
shared-dev/staging path did not have the same operator handoff shape: the
deploy runbook, env repair scripts, and execution checklist existed, but they
were scattered across `docs/`, `docker/`, and `scripts/`.

This change adds a read-only packet exporter for the DingTalk staging stack. It
does not deploy, call Docker, contact staging, or require secrets.

## Changes

- Added `scripts/ops/export-dingtalk-staging-evidence-packet.mjs`.
- Added `scripts/ops/export-dingtalk-staging-evidence-packet.test.mjs`.
- The exporter copies the current staging handoff files into
  `artifacts/dingtalk-staging-evidence-packet` by default:
  - `docs/development/dingtalk-staging-canary-deploy-20260408.md`
  - `docs/development/dingtalk-staging-execution-checklist-20260408.md`
  - `docs/development/dingtalk-live-tenant-validation-checklist-20260408.md`
  - `docs/development/dingtalk-stack-merge-readiness-20260408.md`
  - `docker/app.staging.env.example`
  - `scripts/ops/validate-env-file.sh`
  - `scripts/ops/repair-env-file.sh`
  - `scripts/ops/build-dingtalk-staging-images.sh`
  - `scripts/ops/deploy-dingtalk-staging.sh`
- The exporter writes:
  - `manifest.json`
  - `README.md`
- Optional runtime evidence can be attached with repeated
  `--include-output <dir>` arguments. Each directory is copied under
  `evidence/NN-<basename>`.

## Design Notes

- This intentionally mirrors the Yjs rollout packet pattern, but stays scoped to
  DingTalk staging operations.
- The exporter is fail-closed for required packet files. If a runbook or script
  moves, export fails instead of silently producing an incomplete handoff.
- Optional runtime evidence must point to existing directories. Missing evidence
  paths fail because otherwise an operator could believe a staging smoke was
  attached when it was not.
- Secrets are never read or copied. The packet includes only the staging env
  template, not `docker/app.staging.env`.

## Usage

```bash
node scripts/ops/export-dingtalk-staging-evidence-packet.mjs
```

With runtime smoke evidence:

```bash
node scripts/ops/export-dingtalk-staging-evidence-packet.mjs \
  --include-output output/playwright/dingtalk-directory-staging-smoke/<run>
```

