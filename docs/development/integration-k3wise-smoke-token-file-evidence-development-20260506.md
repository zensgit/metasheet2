# K3 WISE Smoke Token File Evidence Development

Date: 2026-05-06

## Context

The K3 WISE postdeploy smoke writes JSON and Markdown artifacts so a failed
internal trial can be inspected after a GitHub Actions run. One edge case still
exited before evidence was written: a missing or unreadable `--token-file`.

That failure is operationally important because authenticated smoke depends on
token resolution. It should produce the same downloadable evidence shape as
route, staging, or control-plane failures.

## Change

`integration-k3wise-postdeploy-smoke.mjs` now resolves the token into a
structured result:

- successful token resolution behaves unchanged
- missing token with no token file behaves unchanged
- token file read failure becomes an `auth-token` failed check
- the smoke continues through public diagnostics and writes JSON/Markdown
  evidence before returning non-zero

This keeps signoff behavior strict while making the failure auditable.

## Scope

Changed files:

- `scripts/ops/integration-k3wise-postdeploy-smoke.mjs`
- `scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs`
- this development note
- companion verification note

No workflow, summary renderer, token resolver, live preflight, fixture, or UI
files are changed.
