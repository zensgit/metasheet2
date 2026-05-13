# Integration K3 WISE Postdeploy URL Secret Guard Refresh Development - 2026-05-13

## Scope

This slice refreshes the intent of PR #1370 on top of current `main`.

The old PR was still open but conflicted with current `main`. Re-applying the
guard directly avoids merging a stale branch while preserving the security
contract:

- `scripts/ops/integration-k3wise-postdeploy-smoke.mjs` must reject
  secret-bearing MetaSheet `--base-url` values before any network request.
- Error output must not echo inline credentials, query values, or URL hash
  fragments.

## Changes

Updated `scripts/ops/integration-k3wise-postdeploy-smoke.mjs`:

- Added URL-aware redaction for HTTP/HTTPS URLs.
- Kept existing bearer/JWT redaction.
- Rejected `--base-url` values containing inline username/password.
- Rejected `--base-url` values containing query strings or hash fragments.

Updated `scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs`:

- Added a regression test for inline credential rejection.
- Added a regression test for query/hash rejection.
- Both tests assert the raw secret value is absent from stdout/stderr.

## Design Notes

The guard intentionally mirrors the stricter postdeploy env-check behavior
rather than accepting "safe-looking" query keys. A MetaSheet base URL should be
only protocol, host, optional port, and optional deployment path. Query strings
and hashes are not useful for the smoke target and are too easy to misuse for
tokens or session identifiers.

This is a CLI input guard only. It does not change runtime integration routes,
K3 adapter behavior, or smoke request semantics for valid URLs.

## Files

- `scripts/ops/integration-k3wise-postdeploy-smoke.mjs`
- `scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs`
- `docs/development/integration-k3wise-postdeploy-url-secret-guard-refresh-development-20260513.md`
- `docs/development/integration-k3wise-postdeploy-url-secret-guard-refresh-verification-20260513.md`

## Non-Goals

- No live K3 customer endpoint call.
- No GitHub Actions workflow change.
- No package/build script change.
- No attempt to merge the stale/conflicting #1370 branch.
