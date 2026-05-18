# Data Factory issue #1526 GATE contract package verification design - 2026-05-18

## Purpose

PR #1593 and the follow-up GATE checker made the K3 WISE read/list and
relationship contracts executable, but the bridge/on-prem operator only benefits
if the checker is present in the generated Windows package.

This slice promotes the checker from "repo-local helper" to "packaged operator
gate" by adding it to the multitable on-prem package manifest and making package
verification fail when it is missing or hollow.

## Scope

Changed:

- `scripts/ops/multitable-onprem-package-build.sh`
- `scripts/ops/multitable-onprem-package-verify.sh`
- this design note
- companion verification note

Packaged additions:

- `scripts/ops/integration-k3wise-gate-contract-check.mjs`
- `docs/operations/integration-k3wise-webapi-read-list-customer-sample-manifest.md`
- `docs/operations/integration-k3wise-relationship-mapping-customer-sample-manifest.md`
- `docs/development/data-factory-issue1526-gate-contract-check-design-20260518.md`
- `docs/development/data-factory-issue1526-gate-contract-check-verification-20260518.md`

Not changed:

- no `plugins/plugin-integration-core`
- no runtime K3 read/list implementation
- no SQL executor/runtime implementation
- no relationship resolver runtime
- no DB migration
- no frontend route or API contract

## Design

### Build manifest

`multitable-onprem-package-build.sh` already carries an explicit
`REQUIRED_PATHS` manifest for operator-critical files. This change adds the GATE
contract checker and its customer-facing manifests to that manifest.

The package `INSTALL.txt` K3 WISE operator section now includes the checker
command between live preflight and evidence compilation:

```bash
node scripts/ops/integration-k3wise-gate-contract-check.mjs \
  --input <contract.json> \
  --out-dir <art>
```

That placement matches the live chain: customer GATE answers arrive, the
operator validates O1-O6/R1-R7 evidence, and only then should a post-GATE
runtime PR start.

### Package verifier

`multitable-onprem-package-verify.sh` now enforces two levels:

1. Required content exists in the package archive.
2. The packaged files still contain the contract-critical strings:
   - `READ_ANSWER_IDS`
   - `RELATIONSHIP_ANSWER_IDS`
   - `GATE_BLOCKED`
   - `SECRET_QUERY_PATTERN`
   - manifest links to `integration-k3wise-gate-contract-check.mjs`
   - manifest answer IDs such as `O1-MAT` and `R1`

This catches both missing files and accidental replacement with the wrong doc or
stub script.

## Stage 1 Lock

The Stage 1 Lock remains intact. This is an ops/package verification slice only.
It ensures customer evidence can be checked on the bridge machine without
implementing any K3 read/list, SQL, or relationship runtime.

## Operator impact

After this change, the package verifier becomes the deploy-time answer to:

> Does this on-prem package contain the tooling needed to validate customer
> GATE evidence before we start the remaining #1526 runtime work?

If the answer is no, the package verify step fails before deployment.
