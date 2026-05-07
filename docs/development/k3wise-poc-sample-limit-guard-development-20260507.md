# K3 WISE PoC Sample Limit Guard Development - 2026-05-07

## Context

K3 WISE live PoC evidence requires material Save-only writes to stay between 1 and 3 rows. The preflight packet generator and frontend setup helper did not enforce the same limit before execution:

- preflight used `gate.k3Wise.sampleLimit || 3`
- frontend defaulted `pipelineSampleLimit` to `20`
- frontend validation only checked positive integer shape

That could produce a `preflight-ready` packet or live run payload that evidence would later reject, and it could write more customer test rows than the PoC contract allows.

## Design

- Define the material Save-only sample limit as 1 to 3 rows in preflight.
- Normalize numeric and numeric-string `k3Wise.sampleLimit` values.
- Reject `0`, values above `3`, and non-numeric strings before packet generation.
- Change the frontend default sample limit from `20` to `3`.
- Add frontend validation so K3 WISE pipeline run payloads cannot exceed 3 rows.
- Add `min="1"` and `max="3"` attributes to the setup page input.

## Files Changed

- `scripts/ops/integration-k3wise-live-poc-preflight.mjs`
- `scripts/ops/integration-k3wise-live-poc-preflight.test.mjs`
- `apps/web/src/services/integration/k3WiseSetup.ts`
- `apps/web/tests/k3WiseSetup.spec.ts`
- `apps/web/src/views/IntegrationK3WiseSetupView.vue`

## Behavior

- `sampleLimit` values `1`, `2`, `3`, and matching numeric strings are accepted.
- Missing sample limit defaults to `3`.
- `sampleLimit` values such as `0`, `4`, `20`, and `abc` are rejected before packet/run payload generation.
- Frontend helper and preflight script now match the evidence row-count contract.

