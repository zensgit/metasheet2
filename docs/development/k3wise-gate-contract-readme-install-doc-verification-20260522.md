# K3 WISE GATE Contract README Install Doc Verification - 2026-05-22

## Scope

This verification covers the docs/package text alignment after
`README-CUSTOMER-HANDOFF.zh.md` became part of the generated GATE contract
packet.

Stage 1 Lock status: held. The change is docs/package-script verification only
and does not touch integration-core runtime, migrations, API routes, frontend
routes, K3 calls, or pipeline execution.

## Local Verification

| Command | Result |
| --- | --- |
| `bash -n scripts/ops/multitable-onprem-package-build.sh` | PASS |
| `bash -n scripts/ops/multitable-onprem-package-verify.sh` | PASS |
| `rg -n "README-CUSTOMER-HANDOFF.zh.md" scripts/ops/multitable-onprem-package-build.sh scripts/ops/multitable-onprem-package-verify.sh docs/operations/integration-k3wise-webapi-read-list-customer-sample-manifest.md docs/operations/integration-k3wise-relationship-mapping-customer-sample-manifest.md` | PASS: 7 hits across generator, verifier, and both manifests |
| `git diff --check origin/main...HEAD` | PASS |

## Expected Markers

The follow-up requires `README-CUSTOMER-HANDOFF.zh.md` in:

- the package `INSTALL.txt` generator;
- the package verifier's `INSTALL.txt` assertion;
- the WebAPI read/list customer sample manifest;
- the relationship mapping customer sample manifest.

## Residual Risk

This does not build a full on-prem package locally. The package verifier is
strengthened so an official package build will fail if the operator-facing
README wording is missing from the generated `INSTALL.txt` or manifests.
