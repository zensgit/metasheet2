# Data Factory postdeploy summary adapter details - development notes - 2026-05-14

## Purpose

This slice closes the operator-observability gap left after the Data Factory
adapter discovery smoke landed.

The smoke already fails when `GET /api/integration/adapters` omits or
mis-describes the local MetaSheet Data Factory adapters. Before this change,
the GitHub Step Summary renderer did not expand `invalidAdapters`, so an
operator had to open the raw JSON evidence to see which adapter field drifted.

## Implementation

`scripts/ops/integration-k3wise-postdeploy-summary.mjs` now includes
`invalidAdapters` in failed-check detail rendering.

This means a failed `data-factory-adapter-discovery` check can show details
such as:

```text
invalidAdapters: metasheet:staging: guardrails.write.supported: `expected false but got true`
```

The existing nested-detail formatter is reused. No new evidence schema,
workflow option, or backend route was added.

## Files Changed

- `scripts/ops/integration-k3wise-postdeploy-summary.mjs`
  - renders `invalidAdapters` alongside `missingAdapters`, `missingRoutes`,
    `missingFields`, and `invalidFields`.
- `scripts/ops/integration-k3wise-postdeploy-summary.test.mjs`
  - adds a regression case for Data Factory adapter metadata drift details.
- `scripts/ops/multitable-onprem-package-build.sh`
  - includes this development/verification note pair in the on-prem package.
- `scripts/ops/multitable-onprem-package-verify.sh`
  - verifies the packaged postdeploy summary renderer still contains the
    `invalidAdapters` detail path;
  - verifies this document pair is included in the package.

## Deployment Impact

- No runtime API change.
- No migration.
- No live external request.
- No write operation.
- Existing smoke evidence JSON shape remains unchanged.

The change only improves how already-collected failure evidence is rendered in
operator summaries.
