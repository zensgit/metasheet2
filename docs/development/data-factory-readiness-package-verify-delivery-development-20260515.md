# Data Factory Readiness Package Verify Delivery Development - 2026-05-15

## Purpose

This slice wires the existing K3 WISE delivery-readiness compiler into the
operator package path.

Before this change, `integration-k3wise-delivery-readiness.mjs` could consume a
package verifier JSON report through `--package-verify`, but the on-prem package
did not guarantee that the compiler itself was shipped. The live GATE runbook
also stopped at the C10 live evidence compiler, leaving no packaged command path
for producing the final `integration-k3wise-delivery-readiness.{json,md}`
handoff record.

The goal is to make the installable package self-contained:

1. the package contains the readiness compiler;
2. the package verifier requires it;
3. the live GATE runbook shows how to capture `VERIFY_REPORT_JSON`;
4. the final readiness command combines postdeploy smoke, package verify,
   preflight packet, and optional live evidence.

## Changed Files

- `scripts/ops/multitable-onprem-package-build.sh`
- `scripts/ops/multitable-onprem-package-verify.sh`
- `docs/operations/integration-k3wise-live-gate-execution-package.md`
- `docs/operations/integration-k3wise-internal-trial-runbook.md`
- `docs/development/data-factory-readiness-package-verify-delivery-development-20260515.md`
- `docs/development/data-factory-readiness-package-verify-delivery-verification-20260515.md`

## Behavior

### Package contents

`multitable-onprem-package-build.sh` now includes:

```text
scripts/ops/integration-k3wise-delivery-readiness.mjs
```

It also includes the delivery-readiness development and verification notes so
offline package reviewers can see why the readiness gate exists.

### Package verifier

`multitable-onprem-package-verify.sh` now requires:

- the delivery-readiness compiler file to exist in the archive;
- the compiler to support `--package-verify`;
- the compiler to still emit the `CUSTOMER_TRIAL_READY` decision;
- the live GATE runbook to document `VERIFY_REPORT_JSON`;
- the live GATE runbook to document the `--package-verify` readiness gate.

This turns a missing readiness compiler into a package verification failure
instead of a deploy-time surprise.

### Operator runbooks

The live GATE package now has two explicit steps:

- **C0.5 package verify report**: run the package verifier with
  `VERIFY_REPORT_JSON` and `VERIFY_REPORT_MD`.
- **C11 delivery readiness compiler**: combine package verify, authenticated
  postdeploy smoke, preflight packet, and optional live evidence into one
  readiness artifact.

The internal-trial runbook now points operators from postdeploy smoke to the
same delivery-readiness handoff path.

## Scope Boundary

This slice does not:

- implement a SQL Server executor;
- change K3 WebAPI or Data Factory runtime behavior;
- add migrations;
- change customer GATE requirements;
- approve production use.

It only tightens the operator delivery chain around existing scripts.

## Claude Code

Claude Code is not required for this slice. The work is local repo packaging,
docs, and shell/Node test verification. Claude Code becomes useful again when
the bridge machine needs a real allowlisted SQL executor implementation and
live Windows/K3 connectivity checks.
