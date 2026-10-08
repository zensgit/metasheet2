# 备料 structure-exact capability rehearsal — report (2026-09-01)

**Question answered:** does the 备料 pipeline (steps 1–3 of the customer's business
process) work **end-to-end on our stack** against a synthetic dataset shaped
**exactly** like the customer's real PLM schema — so that on-site the only variable
is the customer's data?

**Answer:** yes for the parts that exist, proven mechanically and GREEN. The parts
that do **not** exist yet are named as gaps at the end and are **not** faked.

## What ran

| Artifact | Path |
|---|---|
| Structure-exact synthetic PLM fixture | `plugins/plugin-integration-core/fixtures/stock-preparation-structure-exact-plm/` |
| Rehearsal driver (self-testing, no DB) | `plugins/plugin-integration-core/__tests__/stock-preparation-structure-exact-rehearsal.test.cjs` |

```
$ cd plugins/plugin-integration-core
$ node __tests__/stock-preparation-structure-exact-rehearsal.test.cjs
  STEP 1 GREEN — search SYN-XM-0001 -> 7 rows / SYN-XM-0002 -> 2 rows (independent); phantom SYN-XM-9999 -> not_found; empty target -> PULL (add 7)
  STEP 2 GREEN — 图号/名称/规格/材料/总数量 mapped onto rows; 父组件图号 via in-batch join; batch #1=SYN-XM-0001|2026-08-30T09 vs batch #2=SYN-XM-0001|2026-08-30T10 (distinct by hour, 0 shared line ids)
  STEP 3 GREEN — human fill on 16 columns; canonical+pack human WALL holds (refresh touches only rawQuantity/totalQuantity; negative control clobbers 16); export projects 6 material rows x 10 columns
stock-preparation-structure-exact-rehearsal.test.cjs OK
```

Also GREEN (regression check, same command shape): `stock-preparation-synthetic-sql-fixture`,
`stock-preparation-expansion-snapshot-mapper`, `stock-preparation-ext-field-mapping`,
`stock-preparation-conflict-planner`, `stock-preparation-customer-pack-rehearsal`,
`test-chain-completeness` (189 suites, the new one included).

## The rehearsal is honest by construction

- **No mock that merely agrees with production.** The pipeline is the **shipped
  code** — `expandPlmProjectBom`, the ext-field mapper, the expansion→snapshot
  mapper, `planStockPreparationConflicts` and its `derivePackAwarePlmWritableFields`
  ownership derivation. The **only** synthetic thing is the *source*, which is the
  whole point of a structure-exact rehearsal.
- **The source is shaped like the customer's.** The fixture carries the customer's
  own column vocabulary — `project_code`, `DrawingType` (图号), `TargetName` (名称),
  `Material` (材料), `Specification` (规格), quantity in the generic slot
  `Bom_ExAttr1`, `Createtime` — and the driver reads it through a per-action
  **read-plan override** (`REBIND_READ_PLAN`), which is exactly the on-site
  mechanism (`action.source.readPlan`). Nothing structural was changed to make it
  pass; the traversal is the shipped 7-object graph.
- **Values-free.** All fabricated, `SYN-`/`TZ-` prefixed; a values-free self-check
  scans the printed evidence for host/credential shapes.

## Per-step evidence

### Step 1 — project search + branch (no-data → pull; has-data → fill) ✅

- `SYN-XM-0001` resolves → `status=expanded`, `rootMatches=1`, **7 rows**, 0 errors.
- `SYN-XM-0002` resolves **independently** → 2 rows, different parts (multi-project
  search proven).
- `SYN-XM-9999` (not in PLM) → `status=not_found`, 0 rows — the **phantom-project
  guard** that stops a search pulling a project that does not exist.
- The **branch**: with an empty target sheet the plan is **all-add** (`add 7`) —
  the no-data → PULL path. The has-data → FILL path is proven in step 3.
- A **retired BOM head** (`bom_able='0'`) component (TZ-G) never expands.

### Step 2 — pull → snapshot-batch → multitable rows, columns mapped ✅

The customer's landing-sheet columns land on the rows, from shipped code:

| Column | Source | Where |
|---|---|---|
| 当前组件图号 | `componentCode` ← `DrawingType` | canonical row (`createRow`) |
| 当前组件名称 | `componentName` ← `TargetName` | canonical row |
| 材料 | `material` ← `Material` | canonical row |
| 总数量 | `totalQuantity` (roll-up) | canonical row |
| 规格 | `ext_spec` ← `Specification` | ext-field mapping |
| 父组件图号 | `parentDrawingNo` ← parent `componentCode` | snapshot mapper's in-batch join |
| 父组件名称 | parent `componentName` | same in-batch parent index |

- Quantity roll-up verified across levels: `2 → 6 → 12` (root × sub × leaf).
- Snapshot lines: 7 mapped, **6 carry a parent drawing no** (the root has none).
- **Two same-project batches distinguished by creation-hour:** batch #1 (materials
  created hour 09) mints `SYN-XM-0001|2026-08-30T09`; batch #2 (re-pull, hour 10)
  mints `SYN-XM-0001|2026-08-30T10`. Distinct batch ids → **0 shared snapshot line
  ids**. Same-hour re-derivation is byte-identical (idempotent). **See gap #3** on
  where this rule does and does not live in shipped code.

### Step 3 — human fill + the human-column wall + the export ✅

- A person fills **16 human columns** — the canonical human band
  (材料类型/毛胚类型/备料情况/需求日期/提前周期/备注/…) **and** the pack's human ext
  band (备料日期 `ext_stockPrepDate`, 领料节点 `ext_pickingNode`, 交接工段, 毛胚尺寸
  `ext_blank*`).
- **The wall (canonical band):** a re-pull (batch #2) re-planned against the
  human-filled rows yields `add 0 / update 3 / skip 3 / inactive 1`. The **only**
  changed fields are `rawQuantity` / `totalQuantity`; **no** decision payload names
  any human field; after applying the plan's update+inactive patches, every human
  cell is byte-identical.
- **The wall (pack band):** the production `derivePackAwarePlmWritableFields`
  excludes every pack human ext column from the writable set; a full-sheet refresh
  applied **through** that filter leaves all 16 human cells byte-identical, and the
  **negative control** (same refresh **without** the filter) clobbers all 16 —
  proving the guard is load-bearing.
- **The export warehouse/purchasing takes:** the material rows project to
  `headers[] + rows[][]` — 6 active rows × 10 columns (图号/名称/规格/材料/总数量 +
  备料情况/需求日期/领料节点/备料日期/毛胚长度), each carrying its identity **and**
  the human cells the person typed. This is exactly the input the shipped pure
  builder `buildXlsxBuffer` (`packages/core-backend/src/multitable/xlsx-service.ts`)
  serializes; the **binary packaging** is covered by the existing vitest suite
  `packages/core-backend/tests/integration/multitable-xlsx-routes.test.ts`.

## What could NOT be rehearsed — net-new-and-unbuilt (NOT faked)

1. **Multi-person approval hand-off chain wiring to 备料.** The approval runtime
   exists in the platform, but its hand-off chain is **not wired into** the
   stock-preparation flow. Not exercised here; net-new.
2. **DingTalk 待办 (to-do) push.** No connector wiring exists. Not exercised here;
   net-new.
3. ~~**Batch-by-creation-hour derivation (物料创建日期精确到小时) in shipped code.**~~
   **CLOSED.** As written, this gap said: the shipped mapper requires an opaque
   caller-supplied `snapshotBatchId`, same-project batches are distinguished by a
   persist-time monotonic `snapshotVersion` rather than a creation-hour bucket, and
   the hour-derivation is not in code — the rehearsal computed it caller-side to
   prove the rule *realizable*. All three halves are now shipped:
   `lib/stock-preparation-batch-identity.cjs` carries this rehearsal's own pure
   derivation (the rehearsal calls that module rather than its former private copy,
   so there is one implementation), the read plan DECLARES the creation-time column
   (`part.createTimeField`, defaulted to absent) so the hour rides the expansion row,
   and the table-action MVP-persist route mints `<project>|<YYYY-MM-DDTHH>` at the
   `snapshotBatchId` site.
   **It is OPT-IN, not the default** (`readPlan.batchIdentity.mode =
   'material_create_hour'`): the batch id is the persist idempotency key, the
   advisory-lock key and a hash input for every derived child id, so which pulls
   count as one batch is a behaviour change a running install must choose. Absent
   declaration keeps the content-revision id byte for byte; a deployment that asks
   for the rule but whose source carries no usable creation time falls back to that
   id and reports the degradation with a coded reason. See the module header for the
   full trade-off.

## The single on-site variable this rehearsal deliberately leaves open

The **project→root binding** — how a `project_code` resolves to its top-assembly
root BOM. The recon could not trace it because the test DB's BOM views are
unpopulated (project_code null). The fixture models it as an explicit
project/root layer; the on-site runbook's pre-flight SQL is what determines the
real binding in 30 seconds. Everything downstream of that binding is proven here.

## Environment note

This worktree has **no `node_modules`** and **no `DATABASE_URL`**, so the
core-backend real-DB vitest suites (`stock-preparation-*-realdb.test.ts`) and the
XLSX-binary route test **skip/require setup** here; they are the DB-bound cousins
of what is proven above. The plugin `.cjs` rehearsal depends only on Node builtins
and the shipped plugin modules, so it runs green with plain `node`, on a laptop or
in CI, no database.
