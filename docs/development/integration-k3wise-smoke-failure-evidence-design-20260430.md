# K3 WISE Smoke Failure Evidence Design

## Context

The manual `K3 WISE Postdeploy Smoke` workflow is the signoff path for the
internal K3 WISE trial. It intentionally requires authenticated integration
checks by default.

On 2026-04-30, a manual signoff run against `http://142.171.239.56:8081`
confirmed that the deployed app was reachable, but token resolution failed
before the smoke script ran:

- repository secret `METASHEET_K3WISE_SMOKE_TOKEN` was not configured;
- dispatch input `tenant_id` and repository variable `METASHEET_TENANT_ID` were
  empty;
- deploy-host singleton tenant auto-discovery found no integration tenant
  scope.

That failure is correct for signoff safety, but the workflow exited before the
smoke script could write `integration-k3wise-postdeploy-smoke.json` and
`integration-k3wise-postdeploy-smoke.md`. As a result, there was no downloadable
artifact explaining the blocked state.

## Change

The manual workflow now treats token resolution like the smoke step:

- it has a step id, `token_resolve`;
- it records `token_resolve_rc` in `GITHUB_OUTPUT`;
- it uses `continue-on-error: true` so the smoke script still runs.

The smoke step already supports the desired behavior. With `require_auth=true`
and no token, it writes evidence with:

- `authenticated=false`;
- `signoff.internalTrial=blocked`;
- `authenticated-integration-contract=fail`;
- a redacted reason of `no bearer token supplied`.

The final gate remains strict. It fails when either:

- `token_resolve_rc` is missing or non-zero; or
- `smoke_rc` is missing or non-zero.

This keeps signoff semantics unchanged while making blocked runs auditable.

## Non-Goals

- This does not make public-only smoke a signoff.
- This does not create or store a long-lived GitHub secret.
- This does not bypass tenant scoping or singleton tenant auto-discovery.
- This does not change the production deploy workflow behavior.

## Operational Result

After this change, a missing token or tenant still fails the manual signoff
workflow, but the run should upload a 14-day artifact containing the blocked
evidence JSON, Markdown summary, CLI summary, and stderr log.
