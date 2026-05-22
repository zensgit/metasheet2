# K3 WISE GATE Contract README Install Doc Design - 2026-05-22

## Purpose

PR #1758 made `README-CUSTOMER-HANDOFF.zh.md` part of the canonical
`integration-k3wise-gate-contract-check.mjs --init-template` output. The package
quickstart and customer manifests still described only the fillable packet JSON
and eight redacted sample skeletons.

This slice aligns the operator-facing documentation with the generated output so
future on-prem packages tell users to read the README before filling the packet.

## Scope

Changed:

- `scripts/ops/multitable-onprem-package-build.sh`
- `scripts/ops/multitable-onprem-package-verify.sh`
- `docs/operations/integration-k3wise-webapi-read-list-customer-sample-manifest.md`
- `docs/operations/integration-k3wise-relationship-mapping-customer-sample-manifest.md`
- this design note
- companion verification note

Not changed:

- no `plugins/plugin-integration-core`
- no DB migration
- no API route
- no frontend route
- no K3 read/list runtime
- no relationship resolver runtime
- no SQL executor runtime
- no K3 Save, Submit, or Audit call

## Design

The package `INSTALL.txt` generator now says that `--init-template` creates:

- the fillable O1-O6/R1-R7 GATE contract packet;
- `README-CUSTOMER-HANDOFF.zh.md`;
- eight redacted sample skeleton files.

Both customer-facing manifests now tell the operator that the generated
directory includes the README and that it should be read before replacing
placeholders with customer-approved, redacted evidence.

`multitable-onprem-package-verify.sh` adds three guardrails:

- `INSTALL.txt` must mention `README-CUSTOMER-HANDOFF.zh.md`;
- the WebAPI read/list manifest must mention it;
- the relationship mapping manifest must mention it.

This catches packages where the checker can generate the README but the operator
instructions drift back to the older packet-only wording.

## GATE Boundary

The GATE remains blocked. This change only improves handoff clarity and package
verification. Runtime development for #1709 and #1711 still requires the filled
customer packet to validate with `decision=PASS`.
