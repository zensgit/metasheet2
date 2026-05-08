# K3 WISE GATE Middle-Table Validation - Development

Date: 2026-05-06
Branch: `codex/k3wise-gate-middle-table-validation-20260506`
Stacked on: `codex/erp-plm-config-workbench-20260505` / PR #1305

## Goal

Let the K3 WISE GATE workbench generate valid customer PoC packets for the intended middle-table pattern: read K3 WISE core tables, write only integration middle tables.

## Problem

`validateK3WiseGateDraftForm()` blocked core K3 WISE table names from `sqlAllowedTables` whenever SQL mode was not `readonly`.

That field is the read whitelist and defaults to K3 WISE core tables such as:

- `t_ICItem`
- `t_ICBOM`
- `t_ICBomChild`

The write side is represented by `sqlMiddleTables`, which is serialized into `sqlServer.middleTables` and `writeTables`. The previous validation therefore rejected a safe and expected configuration:

- read `t_ICItem` / `t_ICBOM` / `t_ICBomChild`;
- write `integration_material_stage` / `integration_bom_stage`.

In the UI this would disable copy/download for the GATE JSON draft even though the packet was safe.

## Implementation

Files changed:

- `apps/web/src/services/integration/k3WiseSetup.ts`
- `apps/web/tests/k3WiseSetup.spec.ts`

Changes:

- Moved the "may not write K3 WISE core business tables" check from `sqlAllowedTables` to `sqlMiddleTables`.
- Kept the safety intent intact: core K3 WISE tables are still forbidden as write targets.
- Added regression coverage for:
  - safe read-core/write-middle-table GATE drafts;
  - unsafe middle-table writes targeting `t_ICBomChild`.

## Safety

This is a validation-scope correction only. It does not change the generated K3 WebAPI payload, SQL Server external system payload shape, credentials handling, or runtime adapter behavior.

## Residual Risk

This branch is stacked on the still-open PR #1305. It should be merged after #1305 or retargeted if #1305 is rewritten.
