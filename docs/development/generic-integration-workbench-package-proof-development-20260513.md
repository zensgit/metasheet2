# Generic Integration Workbench Package Proof Development - 2026-05-13

## Scope

This slice adds a package-level guard for the generic integration workbench and K3 WISE quick-start delivery path.

The previous delivery closeout ensured that runbooks and K3 postdeploy tools are copied into the on-prem package. This slice tightens the verifier so a downloaded `.tgz` or Windows `.zip` package also proves that the built frontend contains:

- `/integrations/workbench`
- `/integrations/k3-wise`
- `dictMap` mapping editor support
- Save-only execution copy

It also keeps the operator documentation contract in the package verifier:

- Windows on-prem guide documents both integration routes.
- K3 internal-trial runbook documents SQL Server as an advanced channel.

## Change

Updated `scripts/ops/multitable-onprem-package-verify.sh` with `verify_generic_integration_workbench_contract()`.

The new verifier checks:

- `apps/web/dist` contains `/integrations/workbench`.
- `apps/web/dist` contains `/integrations/k3-wise`.
- `apps/web/dist` contains `dictMap`.
- `apps/web/dist` contains `Save-only`.
- `docs/deployment/multitable-windows-onprem-easy-start-20260319.md` documents `/integrations/workbench`.
- `docs/deployment/multitable-windows-onprem-easy-start-20260319.md` documents `/integrations/k3-wise`.
- `docs/operations/integration-k3wise-internal-trial-runbook.md` documents SQL Server as an advanced channel.

## Why

The package verifier already required the K3 operator scripts and runbooks, but it did not prove that the frontend route bundle actually shipped the workbench entry points. That left a small delivery gap: a package could pass content checks while still missing the operator UI route.

This is intentionally a package verifier guard, not a runtime change.

## Files

- `scripts/ops/multitable-onprem-package-verify.sh`
- `docs/development/generic-integration-workbench-package-proof-development-20260513.md`
- `docs/development/generic-integration-workbench-package-proof-verification-20260513.md`

## Non-Goals

- No frontend source change.
- No backend runtime change.
- No migration.
- No customer live K3 call.
