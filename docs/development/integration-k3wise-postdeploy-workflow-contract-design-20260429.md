# K3 WISE Postdeploy Workflow Contract Test Design

## Context

K3 WISE readiness now depends on two GitHub Actions entrypoints:

- `Build and Push Docker Images` runs the postdeploy smoke after the production deploy job.
- `K3 WISE Postdeploy Smoke` lets an operator manually rerun the same smoke against a selected MetaSheet base URL.

Both entrypoints are operational glue. A future YAML edit could accidentally remove the smoke script, point the summary at the wrong JSON file, drop artifact upload, or disconnect `METASHEET_K3WISE_SMOKE_TOKEN` without breaking ordinary unit tests.

## Change

Add `scripts/ops/integration-k3wise-postdeploy-workflow-contract.test.mjs`.

The test scans the two workflow YAML files for stable contract fragments and keeps the YAML syntax check as a separate verification command. It intentionally avoids extra npm package resolution so it can run with plain `node --test` like the surrounding ops tests.

- Manual workflow remains `workflow_dispatch` with `base_url`, `require_auth`, and `timeout_ms` inputs.
- Manual workflow still passes `METASHEET_K3WISE_SMOKE_TOKEN`, supports `--require-auth`, captures `stderr.log` and `cli-summary.json`, writes `smoke_rc`, uploads artifacts, and gates failure from the script exit code.
- Deploy workflow still runs `scripts/ops/integration-k3wise-postdeploy-smoke.mjs` after a successful remote deploy.
- Deploy summary still renders `output/deploy/k3wise-postdeploy-smoke/integration-k3wise-postdeploy-smoke.json` with `integration-k3wise-postdeploy-summary.mjs --missing-ok`.
- Deploy artifact upload still includes `output/deploy/**`, which contains the K3 WISE smoke evidence.

## Non-Goals

- No runtime behavior change.
- No customer PLM, K3 WISE, SQL Server, or middleware connection.
- No secret generation or token rotation.
- No attempt to make the manual smoke authenticated without `METASHEET_K3WISE_SMOKE_TOKEN`.

## Risk

This is a docs and test-only guard. The main risk is test brittleness if workflow step names intentionally change. That is acceptable because these step names are part of the operator-facing deployment summary and artifact audit trail.
