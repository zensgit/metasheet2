# Bridge Agent Package Verify Development Notes

Date: 2026-05-21

## Purpose

PR #1731 added the BA-M1 readonly Bridge Agent runtime skeleton. This follow-up
makes the Windows on-prem delivery package accountable for shipping the Bridge
Agent operator tools, not just the K3/Data Factory runtime.

Without this gate, the source tree could contain the BA-M0.5/BA-M1 scripts while
the official on-prem zip quietly omits them. That would leave the operator with
a merged runbook but no script on the Windows bridge host.

## Files Changed

- `scripts/ops/multitable-onprem-package-build.sh`
- `scripts/ops/multitable-onprem-package-verify.sh`
- `docs/development/bridge-agent-package-verify-development-20260521.md`
- `docs/development/bridge-agent-package-verify-verification-20260521.md`

## Build Inclusion

The package builder now includes:

- `scripts/ops/bridge-agent-driver-smoke.ps1`
- `scripts/ops/fixtures/bridge-agent-driver-smoke`
- `scripts/ops/bridge-agent-readonly.ps1`
- `scripts/ops/fixtures/bridge-agent-readonly`
- `docs/operations/bridge-agent-driver-smoke-runbook-20260520.md`
- `docs/operations/bridge-agent-readonly-runbook-20260521.md`

`INSTALL.txt` gains a short "Legacy SQL readonly Bridge Agent tools" section so
operators can find BA-M0.5 and BA-M1 from the package root.

## Verify Gate

`multitable-onprem-package-verify.sh` now requires the package to contain the
Bridge Agent files and checks contract markers:

- BA-M0.5 smoke still runs only `SELECT @@VERSION`;
- BA-M0.5 provider names stay configurable for approved legacy drivers;
- BA-M0.5 evidence templates are present;
- BA-M1 uses `System.Data.SqlClient`;
- BA-M1 rejects non-localhost bindings;
- BA-M1 rejects raw SQL and filters;
- BA-M1 builds bounded `SELECT TOP` queries from allowlisted identifiers;
- BA-M1 config keeps credentials/secrets in environment variable names;
- BA-M1 runbook documents localhost, validation, URL ACL, and negative checks.

## Boundaries

This PR does not change the Bridge Agent runtime behavior. It only changes the
delivery package and package verifier.

Still out of scope:

- `plugin-integration-core` integration;
- Data Factory UI wiring;
- SQL writes;
- K3 Save / Submit / Audit;
- customer-GATE changes.
