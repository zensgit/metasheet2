# Data Factory staging field alias design - 2026-05-19

## Purpose

Close the #1526 P0 gap where Data Factory Workbench presents staging fields as logical names
such as `code`, `name`, and `uom`, while the multitable record reader returns provisioned
physical field IDs such as `fld_*`.

The symptom on the bridge machine was:

- `Standard Materials` multitable contained a sample row.
- Workbench saved a `standard_materials -> material` pipeline with logical mappings.
- Dry-run failed with `IDEMPOTENCY_FAILED` because the runner could not resolve the logical
  idempotency field `code`.
- The same pipeline worked when manually patched to use the physical field IDs, proving the
  runner and data path were otherwise healthy.

## Design

The narrow fix lives in `plugins/plugin-integration-core/lib/adapters/metasheet-staging-source-adapter.cjs`.

The staging source adapter now:

1. Reads the staging source system `config.projectId`.
2. Reads each configured staging object ID, for example `standard_materials`.
3. Resolves logical field names through the host multitable provisioning API:
   `context.api.multitable.provisioning.resolveFieldIds({ projectId, objectId, fieldIds })`.
4. Inverts the result into a physical-to-logical alias map.
5. When reading rows, copies physical field values into their logical aliases if the logical
   key is absent.

Example:

```json
{
  "fld_abc123": "MAT-001"
}
```

becomes:

```json
{
  "fld_abc123": "MAT-001",
  "code": "MAT-001"
}
```

Physical keys are deliberately preserved so any temporarily patched pipeline that already uses
physical field IDs keeps working. Logical keys are not overwritten if a record already contains
them, which keeps manual or legacy configs stable.

## Fallbacks

- If the provisioning API is unavailable, behavior remains unchanged.
- If `config.projectId` is unavailable, behavior remains unchanged.
- Operators may provide `config.objects.<objectId>.fieldIdMap` as an explicit
  `logicalField -> physicalField` map for diagnostic/manual systems without provisioning.

## Scope

Included:

- MetaSheet staging source read normalization.
- Regression tests for provisioned physical IDs and explicit `fieldIdMap`.

Excluded:

- SQL Server executor injection.
- K3 WebAPI read/list runtime.
- Relationship resolver runtime.
- DB migrations.
- K3 Save / Submit / Audit behavior.
