# K3 WISE Preflight Mapping Guard Design - 2026-04-29

## Goal

Move one more live PoC failure from customer runtime into local preflight: a packet should not be `preflight-ready` if its field mappings cannot produce the minimum K3 WISE material/BOM payload shape.

Before this change, preflight only required `fieldMappings.material` to contain at least one mapping. A customer packet could map a harmless field, pass preflight, then fail later when K3 Save received no material code/name or no BOM child quantity.

## Scope

Changed files:

- `scripts/ops/integration-k3wise-live-poc-preflight.mjs`
- `scripts/ops/integration-k3wise-live-poc-preflight.test.mjs`

## Contract

The guard checks target fields, not source fields. Customer PLM source field names vary, but the generated K3 WISE target payload must include stable K3 targets.

Material PoC requires mappings to:

- `FNumber`
- `FName`

BOM PoC, when enabled, requires mappings to:

- `FParentItemNumber`
- one child material target: `FChildItems[].FItemNumber`, `FChildItemNumber`, or `FItemNumber`
- one child quantity target: `FChildItems[].FQty` or `FQty`

The matching normalizes whitespace and `[]` notation so customer-authored field names like `FChildItems.FQty` and generated examples using `FChildItems[].FQty` align.

## Safety

This guard does not contact K3 WISE and does not inspect secret values. It only checks the shape of the customer GATE mapping before any packet is written.

## Out Of Scope

- Full K3 schema validation.
- Customer-specific mandatory material dimensions or BOM effectivity fields.
- Transform correctness beyond the target field presence check.
