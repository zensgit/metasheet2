# Data Factory adapter discovery postdeploy smoke - development notes - 2026-05-14

## Purpose

This slice extends the existing K3 WISE postdeploy smoke with a Data Factory
adapter discovery check.

The deployed smoke already verifies the frontend Data Factory route and the
authenticated integration status contract. This change adds one more
authenticated probe:

```text
GET /api/integration/adapters
```

The goal is to catch deployments where the Data Factory UI is reachable but the
local MetaSheet adapters needed for multitable cleansing flows are missing or
mis-described.

## Contract Checked

The smoke now verifies the minimum stable metadata for:

- `metasheet:staging`
  - has `source` role;
  - is not marked advanced;
  - declares host-owned, dry-run friendly, no-external-network read guardrails;
  - declares `guardrails.write.supported: false`.
- `metasheet:multitable`
  - has `target` role;
  - is not marked advanced;
  - supports `testConnection`, `listObjects`, `getSchema`, and `upsert`;
  - declares read unsupported;
  - declares host-owned, plugin-scoped write guardrails with append and keyed
    upsert support.

The smoke intentionally does not require the staging adapter's exact `supports`
list. That keeps this slice independent from the narrower metadata hygiene PR
that makes staging supports explicitly read-only. The read-only staging contract
is enforced through `roles` and `guardrails.write.supported: false`.

## Files Changed

- `scripts/ops/integration-k3wise-postdeploy-smoke.mjs`
  - added `metasheet:staging` and `metasheet:multitable` to required runtime
    adapters;
  - added `/api/integration/adapters` to required integration routes;
  - added `data-factory-adapter-discovery` authenticated smoke check;
  - added metadata validation for Data Factory multitable adapters.
- `scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs`
  - added fake adapter discovery responses;
  - asserted the new pass check in authenticated smoke evidence;
  - added a failure case for lost staging write guardrails.
- `scripts/ops/multitable-onprem-package-build.sh`
  - includes this development/verification note in the Windows on-prem package.
- `scripts/ops/multitable-onprem-package-verify.sh`
  - checks the packaged smoke script still contains the adapter discovery
    smoke check;
  - verifies this document pair is included in the package.

## Deployment Impact

- No backend route change.
- No migration.
- No live K3 call.
- No SQL call.
- No write operation.
- Existing public unauthenticated smoke behavior is unchanged.

Authenticated postdeploy smoke now fails if the deployed integration plugin
does not expose the Data Factory multitable adapter metadata needed by the UI.
