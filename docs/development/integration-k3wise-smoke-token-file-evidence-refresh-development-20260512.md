# K3 WISE Smoke Token File Evidence Refresh Development

Date: 2026-05-12
Branch: `codex/k3wise-smoke-token-file-evidence-refresh-20260512`
Base: `origin/main@72bf68f49`

## Context

PR #1330 aimed to preserve postdeploy smoke evidence when a configured token
file cannot be read. Current `main` still reads the token before initializing
the check list; a missing `--token-file` exits through the top-level CLI error
handler and does not write `integration-k3wise-postdeploy-smoke.json` or
`.md`.

The stale #1330 branch also includes broader operator-permission work. This
refresh deliberately keeps scope to the token-file evidence gap only.

## Changes

- `scripts/ops/integration-k3wise-postdeploy-smoke.mjs`
  - Adds `resolveToken(opts)` around `readToken(opts)`.
  - Converts token-read errors into an `auth-token` failing check.
  - Continues public smoke probes and final evidence rendering even when the
    token file is missing.

- `scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs`
  - Adds a regression where `--token-file` points to a missing file and
    `--require-auth` is enabled.
  - Asserts the CLI exits nonzero, writes both JSON and Markdown evidence, and
    records `auth-token` plus `authenticated-integration-contract` failures.

## Non-Goals

- No operator-permission gate changes.
- No workflow YAML changes.
- No changes to authenticated route/staging descriptor contract checks.

