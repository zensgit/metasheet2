# K3 WISE Preflight URL Secret Guard Refresh Development - 2026-05-13

## Context

PR #1337 was still open from the 2026-05-06 K3 WISE stale queue. Its original goal was to prevent customer secrets from being embedded in preflight endpoint URLs before generated packets or Markdown evidence are archived.

Current `main` already contains a broader implementation than #1337:

- `validateUrl()` calls `assertNoSecretLikeText()`.
- URL username/password components are rejected.
- Secret-bearing query parameters are rejected.
- Free-text token forms such as `Bearer ...`, JWTs, `SEC...`, and `password=...` are rejected.
- `buildPacket()` already tests K3 API URL and PLM base URL rejection.

The remaining gap was customer-facing guidance and one compatibility assertion from the stale PR: non-secret routing query parameters should remain accepted.

## Change

This refresh keeps source behavior unchanged and adds only the missing closeout pieces:

- Update the K3 WISE fixture README so customers know endpoint URLs must not contain credentials or token-like query parameters.
- Update `gate-sample.json` with the same instruction before customers copy it out of Git.
- Extend the existing preflight URL secret test to assert that a non-secret PLM routing query parameter survives normalization.

## Scope Control

This is intentionally not a reimplementation of #1337. The older branch added a narrower `optionalUrl()` path and URL-only guard. Current `main` is stronger because the shared `assertNoSecretLikeText()` path also scans generated packets recursively.

## Files

- `scripts/ops/fixtures/integration-k3wise/README.md`
- `scripts/ops/fixtures/integration-k3wise/gate-sample.json`
- `scripts/ops/integration-k3wise-live-poc-preflight.test.mjs`
- `docs/development/integration-k3wise-preflight-url-secret-guard-refresh-development-20260513.md`
- `docs/development/integration-k3wise-preflight-url-secret-guard-refresh-verification-20260513.md`
