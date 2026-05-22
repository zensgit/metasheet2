# MetaSheet Multitable Target Field-ID Mapping Design - 2026-05-22

## Summary

BA-M3 entity-machine verification for release `multitable-onprem-k3wise-20260522-a235a5c1`
reached the Bridge Agent source read, transform, and target-write phase, then failed
all three staging target writes with:

```text
METASHEET_MULTITABLE_WRITE_FAILED
Unknown fieldId: sourceSystemId
```

The failure was not in the Bridge Agent SQL read path and not in K3 WISE
Save/Submit/Audit. The `metasheet:multitable` target adapter was sending logical
staging field ids such as `sourceSystemId`, `objectType`, and `sourceId` directly
to `context.api.multitable.records.createRecord()` / `patchRecord()`. The
multitable records API expects the provisioned physical field ids (`fld_*`) for
the installed sheet.

## Design

The target adapter now mirrors the existing read-side staging source behavior:

1. Normalize optional `config.projectId` and per-object `config.objects.*.fieldIdMap`.
2. Resolve the object field map from `context.api.multitable.provisioning.resolveFieldIds()`.
3. Cache one logical-to-physical map per object id.
4. Keep upsert validation and dead-letter keys in logical field space.
5. Map only the actual records API boundary to physical field ids:
   - `queryRecords.filters`
   - `patchRecord.changes`
   - `createRecord.data`

This keeps pipeline configuration, field mappings, run summaries, and operator
evidence readable as logical Data Factory fields while satisfying the lower-level
multitable records contract.

## Contract

Input records remain logical:

```json
{
  "sourceSystemId": "bridge_source_1",
  "objectType": "material",
  "sourceId": "1",
  "code": "MAT-001",
  "name": "Bolt"
}
```

If provisioning resolves:

```json
{
  "sourceSystemId": "fld_sourceSystemId",
  "objectType": "fld_objectType",
  "sourceId": "fld_sourceId",
  "code": "fld_code",
  "name": "fld_name"
}
```

the target adapter writes:

```json
{
  "fld_sourceSystemId": "bridge_source_1",
  "fld_objectType": "material",
  "fld_sourceId": "1",
  "fld_code": "MAT-001",
  "fld_name": "Bolt"
}
```

## Boundaries

- No DB migration.
- No frontend change.
- No K3 WISE Save, Submit, or Audit behavior change.
- No raw SQL path change.
- No Bridge Agent SQL driver/runtime change.
- No change to the multitable records API contract.

## Deployment Impact

The fix must ship inside the Windows on-prem package because BA-M3 runs the
packaged `plugins/plugin-integration-core` target adapter. The package verify
script now checks that the adapter contains the target-side field-id mapping
helpers and that this design/verification pair is present in the package.

## Entity-Machine Retest

After merge and package rebuild, rerun the same BA-M3 command used on the entity
machine. Expected result:

- `bridge-refresh-material-run`: pass
- `bridge-refresh-bom-run`: pass
- `bridge-refresh-bom_child-run`: pass
- no new `METASHEET_MULTITABLE_WRITE_FAILED` dead letters caused by
  `Unknown fieldId: sourceSystemId`
