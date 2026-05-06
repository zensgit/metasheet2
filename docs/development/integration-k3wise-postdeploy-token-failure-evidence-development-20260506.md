# K3 WISE Postdeploy Token Failure Evidence Development - 2026-05-06

## Context

The K3 WISE postdeploy smoke path is intended to preserve evidence even when
authenticated signoff is blocked. Two delivery-time gaps could hide useful
failure evidence:

- `integration-k3wise-postdeploy-smoke.mjs` read `--token-file` before creating
  the evidence object, so a missing token file failed the CLI without writing
  JSON or Markdown artifacts.
- The deploy workflow token resolver could fail before the K3 smoke step ran,
  leaving the deploy summary with only a missing-evidence message instead of a
  concrete blocked-signoff artifact.

## Change

### Smoke CLI

`scripts/ops/integration-k3wise-postdeploy-smoke.mjs` now catches token-read
errors and records them as an `auth-token-read` failed check. The rest of the
smoke still runs, so the CLI writes:

- `integration-k3wise-postdeploy-smoke.json`
- `integration-k3wise-postdeploy-smoke.md`

When `--require-auth` is also set, the existing
`authenticated-integration-contract` check fails because no bearer token is
available. This makes the output explicit: token read failed, and authenticated
checks did not run.

### Deploy Workflow

`.github/workflows/docker-build.yml` now mirrors the manual K3 WISE smoke
workflow contract:

- token resolver has `id: k3_token_resolve`
- token resolver uses `continue-on-error: true`
- resolver writes `token_resolve_rc`
- K3 smoke has `id: k3_smoke`
- K3 smoke uses `continue-on-error: true`
- smoke writes `stderr.log`, `cli-summary.json`, and `smoke_rc`
- final deploy gate fails when token resolution or K3 smoke failed, after
  summary/artifact upload has had a chance to run

## Files

- `.github/workflows/docker-build.yml`
- `scripts/ops/integration-k3wise-postdeploy-smoke.mjs`
- `scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs`
- `scripts/ops/integration-k3wise-postdeploy-workflow-contract.test.mjs`

## Delivery Impact

This does not make a failed deployment pass. It changes the failure mode from
"hard failure before evidence exists" to "blocked signoff with concrete JSON,
Markdown, stderr, and CLI summary artifacts". That matters for the K3 WISE
delivery path because customer or environment-provided tokens are one of the
last external inputs before live PoC execution.

After this change, a deploy with an unreadable token file should still produce a
reviewable K3 WISE smoke artifact and then fail the final deploy gate. The
failure remains loud, but the next engineer has the evidence needed to determine
whether the issue is token resolution, auth coverage, base URL reachability, or
the integration contract itself.

## Non-Goals

- This does not change how K3 WISE smoke tokens are generated.
- This does not weaken `--require-auth`; missing auth still fails the smoke.
- This does not attempt a real K3 WISE or PLM live connection. That remains
  blocked on the customer GATE answers and test endpoints.
