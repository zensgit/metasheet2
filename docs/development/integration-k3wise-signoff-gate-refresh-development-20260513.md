# K3 WISE Signoff Gate Refresh Development - 2026-05-13

## Context

PR #1324 and PR #1326 were still open from the 2026-05-06 K3 WISE stale queue:

- #1324 added a machine-readable postdeploy signoff gate.
- #1326 hardened the human-readable postdeploy summary so contradictory evidence cannot render `Internal trial signoff: PASS`.

Current `main` already includes the newer postdeploy evidence preservation work from #1501, #1502, #1503, and the K3 workbench release docs. This refresh reapplies the still-missing signoff semantics on top of current `main`.

## Change

Added `scripts/ops/integration-k3wise-signoff-gate.mjs`.

The gate accepts:

```bash
node scripts/ops/integration-k3wise-signoff-gate.mjs --input <evidence.json>
```

It returns exit `0` only when all of the following hold:

- `ok === true`
- `authenticated === true`
- `signoff.internalTrial === "pass"`
- `summary.fail === 0`
- required authenticated checks are present and passing:
  - `auth-me`
  - `integration-route-contract`
  - `integration-list-external-systems`
  - `integration-list-pipelines`
  - `integration-list-runs`
  - `integration-list-dead-letters`
  - `staging-descriptor-contract`

The manual `K3 WISE Postdeploy Smoke` workflow invokes this gate in the final failure step when `require_auth=true`. Summary and artifact upload still run before the final gate, so blocked signoff evidence is preserved.

## Summary Consistency

`integration-k3wise-postdeploy-summary.mjs` now treats explicit or inferred signoff PASS as valid only when:

- top-level `ok` is true
- authenticated checks ran
- `summary.fail` is zero

If a stale or hand-edited evidence file says `signoff.internalTrial="pass"` while one of those fields contradicts it, the summary renders `Internal trial signoff: BLOCKED` and names the inconsistent field.

## Disposition Of Old PRs

This current-main refresh supersedes:

- #1324 `test(integration): add K3 WISE signoff evidence gate`
- #1326 `fix(integration): block inconsistent K3 signoff summaries`

Both old PRs should be closed after this branch is opened because their original branches are stale and split one signoff concern across two PRs.

## Files

- `.github/workflows/integration-k3wise-postdeploy-smoke.yml`
- `scripts/ops/integration-k3wise-signoff-gate.mjs`
- `scripts/ops/integration-k3wise-signoff-gate.test.mjs`
- `scripts/ops/integration-k3wise-postdeploy-summary.mjs`
- `scripts/ops/integration-k3wise-postdeploy-summary.test.mjs`
- `scripts/ops/integration-k3wise-postdeploy-workflow-contract.test.mjs`
- `docs/development/integration-k3wise-signoff-gate-refresh-development-20260513.md`
- `docs/development/integration-k3wise-signoff-gate-refresh-verification-20260513.md`
