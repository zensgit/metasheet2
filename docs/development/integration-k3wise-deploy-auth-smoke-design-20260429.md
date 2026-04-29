# K3 WISE Deploy Authenticated Smoke Design - 2026-04-29

## Context

The K3 WISE postdeploy smoke has two modes:

- public checks only when no token is available.
- authenticated checks when a bearer token is resolved.

Public-only smoke is useful for manual diagnostics, but it is too weak for the
production deploy workflow. The staging descriptor, route, adapter, list-probe,
and field-detail contracts all require authenticated API access. If deploy
token resolution is optional, a missing token can make deploy pass without
running the checks that protect the PLM-to-K3 workflow.

## Design

The deploy workflow now makes K3 WISE postdeploy smoke authenticated by
default:

- token resolution uses `K3_WISE_TOKEN_RESOLVE_REQUIRED: 'true'`.
- the deploy smoke command always passes `--require-auth`.

The manual `K3 WISE Postdeploy Smoke` workflow keeps its explicit
`require_auth` input. Manual operators can still run public-only diagnostics by
choosing `false`; production deploy cannot silently downgrade.

## Failure Mode

If no configured token is present and deploy-host fallback cannot mint one, the
token resolver fails before the smoke step. If the smoke starts without an auth
token for any reason, `--require-auth` makes the smoke fail rather than produce
a PASS with skipped authenticated checks.

## Files

- `.github/workflows/docker-build.yml`
- `scripts/ops/integration-k3wise-postdeploy-workflow-contract.test.mjs`

## Non-Goals

- This does not change the smoke script itself.
- This does not change the manual diagnostic workflow.
- This does not print or persist tokens beyond the existing masked
  `GITHUB_ENV` handoff.
