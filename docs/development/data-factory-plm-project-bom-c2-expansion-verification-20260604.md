# Data Factory #2253 C2 PLM BOM expansion verification (2026-06-04)

## Scope

PR scope: C2 `projectNo -> PLM BOM` dry-run expansion helper.

This slice adds a plugin-local helper that expands a project BOM by repeatedly
calling a `data-source:sql-readonly`-style source adapter with `{ object,
filters }`. It is intentionally service/helper-only.

No route, UI, MetaSheet row write, external database write, raw SQL, stored
procedure, vendor API, migration, or K3 Save / Submit / Audit / BOM path is
added.

## Relation contract used

The default read plan is the field/table-name-only candidate posted to #2253:

- project match: `DN_PDM_PathExAttrInfo.FileCode`
- project path id: `DN_PDM_PathExAttrInfo.Parent_OBJ_ID`
- path object: `DN_PDM_PathInfo.OBJ_ID`
- order head: `DN_PDM_OrderHeadInfo.path_id`, `DN_PDM_OrderHeadInfo.OBJ_ID`
- root detail: `DN_PDM_OrderDetailInfo.order_id`,
  `DN_PDM_OrderDetailInfo.part_id`, `DN_PDM_OrderDetailInfo.quantity`
- component lookup: `DN_PDM_PartLibraryInfo.OBJ_ID`, `IdentityNo`,
  `IdentityName`, `Material`, `SysVer`
- child BOM head: `DN_PDM_BomHeadInfo.part_id`,
  `DN_PDM_BomHeadInfo.bom_id`, optional `DN_PDM_BomHeadInfo.SysVer`,
  active marker `DN_PDM_BomHeadInfo.bom_able`
- child detail: `DN_PDM_BomDetailsInfo.bom_pid`,
  `DN_PDM_BomDetailsInfo.part_id`, `DN_PDM_BomDetailsInfo.Bom_ExAttr1`

The helper validates read-plan shape fail-closed: unsafe identifiers,
non-readonly source kinds, raw SQL, query, where, joins, CTEs, stored
procedures, vendor API hooks, and embedded rows/data are rejected before any
read.

## Verification run

Command:

```bash
pnpm --filter plugin-integration-core test:stock-preparation-bom-expansion
```

Result:

```text
stock-preparation-bom-expansion.test.cjs OK
```

## Test locks

- blank `projectNo` rejects;
- no-hit returns `valid=true`, `status=not_found`, `0 rows`, and zero action
  counts;
- project lookup is exact `FileCode = projectNo`;
- every PLM call goes through adapter `read({ object, filters })`;
- recursive child reads use parent component id plus source version when
  present;
- quantity multiplication preserves edge `rawQuantity` and computes
  `totalQuantity`;
- same component under different parents remains distinct via parent/path and
  different `idempotencyKey`;
- `maxDepth`, `maxRows`, and cycle guard fail closed;
- non-numeric required quantity produces a row error and does not create that
  row;
- duplicate component/path identity lookups fail closed instead of picking the
  first matching row;
- values-free evidence summary contains counts, object names, field/error
  types, and no project number, component source id, component name, or material
  value.

## Important boundary

C2 is a dry-run expansion helper, not the conflict planner.

It exposes candidate rows and `candidateRows` in the summary. It does not
compute `add`, `update`, `skip`, `inactive`, or `manual_confirm`; those remain
the C3 conflict-planner responsibility.

## Field validation status

This PR proves the C2 helper honors the accepted read-plan contract and uses
flat parameterized reads. It does **not** prove the customer's live PLM schema
contains rows matching those descriptors. That remains an entity-machine /
customer-schema validation step before C3/C4 write planning.
