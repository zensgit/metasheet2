# Structure-exact synthetic PLM source (备料 steps 1–3)

A synthetic PLM BOM read source shaped **exactly** like the customer's real
`DN_PDM` / `DN_*_View` schema family, so that an on-site test's only variable is
the customer's **data**. 100% fabricated, values-free: every id is `SYN-`/`TZ-`
prefixed, every material grade is a published national-standard designation
(GB/T — industry vocabulary), and there are no real project codes, drawing
numbers, names, hostnames or credentials.

## Why a second fixture

`../stock-preparation-synthetic-sql-source/` proves the **default** read plan's
read surface and its guard forbids any column the default plan never reads. That
is exactly why it cannot carry the columns this one needs: the customer's live
views expose semantic columns under the customer's **own vocabulary**
(`project_code`, `DrawingType` 图号, `TargetName` 名称, `Material` 材料,
`Specification` 规格, the quantity in the generic dictionary slot `Bom_ExAttr1`,
and `Createtime`). Reading them needs a per-action **read-plan override** plus the
**ext-field mapping** — which this fixture models and its driver exercises.

## What the recon measured (2026-08-31, customer test PLM)

The BOM family is the **DN PDM family** (the `dn-pdm-family` preset targets it).
The semantic columns live on **views** (`DN_BomHead_View` / `DN_Bom_View` /
`DN_BomDetails_View`): `bom_id`, `part_id`, `bom_pid` (parent link), `sort_id`,
`project_code`, `DrawingType`, `TargetName`, `Material`, `Specification`,
`Createtime`/`Creator`, and quantity (总数量) hiding in `Bom_ExAttr1`. On the
**test** DB these are structurally present but **unpopulated** (project_code null,
DrawingType null, names opaque GUIDs) — which is why steps 1–2 cannot be demoed
against it, and why this synthetic fixture exists.

## Files

| File | Role |
|------|------|
| `01-schema.sql` | The 7 objects, unquoted lower-case identifiers (Postgres folding) |
| `02-seed-batch-1.sql` | Two projects (`SYN-XM-0001` 7-row tree, `SYN-XM-0002` 2-row tree); `Createtime` hour **09** |
| `03-seed-batch-2.sql` | Re-pull of `SYN-XM-0001`, `Createtime` hour **10**; TZ-E removed, TZ-C qty 1→2 |

Load order: `01` → `02` → (pull, batch #1) → `03` → (re-pull, batch #2).

## The read-plan override (customer vocabulary → shipped traversal)

`expandPlmProjectBom` always walks the 7-object graph
`project → path → root → root-line → part → bomHead → bomDetail → part`. The
object/field **names** are per-action config. The driver's `REBIND_READ_PLAN`
binds them to this fixture's columns:

| plan role.field | fixture column | canonical row / ext target |
|---|---|---|
| `matchField` / `pathExAttr.matchField` | `project_code` | (project search key) |
| `part.codeField` | `DrawingType` | `componentCode` 图号 |
| `part.nameField` | `TargetName` | `componentName` 名称 |
| `part.materialField` | `Material` | `material` 材料 |
| `bomDetail.quantityField` | `Bom_ExAttr1` | `rawQuantity` → `totalQuantity` 总数量 |
| ext mapping | `Specification` | `ext_spec` 规格 |
| ext mapping | `Creator` | `ext_designer` 设计者 |

## Two honest caveats (see the rehearsal report and the on-site runbook)

1. **Project→root binding.** The three project/root objects
   (`DN_Project_View` / `DN_ProjectRoot_View` / `DN_ProjectRootLine_View`) model
   **how a project anchors its top assembly** — the one binding the recon could
   **not** trace against the empty test data. On site this is the single thing to
   confirm against the customer's populated data; the runbook's pre-flight SQL
   determines it.
2. **Batch-by-creation-hour (物料创建日期精确到小时).** `Createtime` is present so
   the driver can bucket a pull by its materials' creation hour and feed the
   result as the (opaque, caller-supplied) `snapshotBatchId` the shipped mapper
   requires. The **hour-derivation itself is not yet in shipped code** — it is a
   thin caller-side step that belongs upstream of the mapper. The fixture proves
   the rule is *realizable* over the shipped mapper; wiring it is net-new.

Driven by `../../__tests__/stock-preparation-structure-exact-rehearsal.test.cjs`
(no database; the seeds are interpreted in memory).
