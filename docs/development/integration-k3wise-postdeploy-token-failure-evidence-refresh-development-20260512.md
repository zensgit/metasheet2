# K3 WISE Postdeploy Token Failure Evidence Refresh Development

Date: 2026-05-12
Branch: `codex/k3wise-postdeploy-token-failure-evidence-refresh-20260512`
Base: `origin/main@fb91f98a9`

## Context

PR #1342 tried to preserve K3 WISE deploy/postdeploy evidence when smoke token
resolution fails. Current `main` already contains the CLI-side evidence fix
from #1502, but the deploy workflow still ran the token resolver as a hard
step. When required token resolution failed, the job stopped before the K3 WISE
postdeploy smoke could write structured evidence.

This refresh wires the deploy workflow into the current CLI behavior without
reverting newer postdeploy smoke hardening.

## Changes

- `.github/workflows/docker-build.yml`
  - Gives the deploy token resolver step `id: k3_token_resolve`.
  - Marks token resolver, env-check, and smoke steps `continue-on-error: true`.
  - Captures `token_resolve_rc`, `env_check_rc`, and `smoke_rc` in step outputs.
  - Runs the smoke step whenever the remote deploy succeeds, instead of gating
    it on env-check success.
  - Tees env-check and smoke stderr/stdout into their artifact directories.
  - Keeps the existing deploy summary and artifact upload paths.
  - Extends the final deploy gate to fail on nonzero token/env/smoke rc after
    artifacts and summary have been written.

- `scripts/ops/integration-k3wise-postdeploy-workflow-contract.test.mjs`
  - Locks the deploy workflow contract for the non-blocking token/env/smoke
    evidence flow.

## Non-Goals

- No changes to `integration-k3wise-postdeploy-smoke.mjs`; #1502 already covers
  CLI evidence generation for token-file failures.
- No operator-permission gate changes.
- No manual workflow behavior changes.

