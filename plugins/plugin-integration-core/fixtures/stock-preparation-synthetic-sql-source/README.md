# Synthetic PLM BOM read source (stock preparation / 备料)

A throwaway PostgreSQL dataset that the stock-preparation table action can actually read, so the
**read → plan → apply** path can be exercised without the customer's real database.

Why it exists: the BOM pull only accepts `data-source:sql-readonly` or `bridge:legacy-sql-readonly`
(`plugins/plugin-integration-core/lib/stock-preparation-bom-expansion.cjs:21-24`, enforced at
`plugins/plugin-integration-core/lib/stock-preparation-table-actions.cjs:132-137`). There was no
synthetic source to point it at, so nobody could run the pull end to end. These four SQL files are
that source.

Everything here is fabricated: `SYN-` prefixed ids, invented material codes, no customer names, no
real drawing numbers, no hostnames, no credentials.

| File | What it is |
| --- | --- |
| `01-schema.sql` | The 7 tables of the default read plan, and only those |
| `02-seed-pull-1.sql` | Pull #1 state (complete refill) |
| `03-seed-pull-2.sql` | Pull #2 state (complete refill; two PLM-owned edits) |
| `04-optional-duplicate-expanded-key.sql` | Optional, additive, **makes the plan invalid on purpose** |
| `05-seed-subtree-roots.sql` | Optional, additive, exercises the **optional** `readPlan.projectSubtree` root discovery |

The guard that keeps all of this honest is
`plugins/plugin-integration-core/__tests__/stock-preparation-synthetic-sql-fixture.test.cjs`. It
needs no database: it parses the DDL, asserts it covers every object and field the normalized read
plan touches (and declares nothing the plan never reads), then replays both seeds through the real
expander and the real conflict planner and pins the decision counts.

---

## 1. Load it into any Postgres

Any PostgreSQL 12+ instance. Nothing in the fixture is version-specific.

```bash
createdb syn_plm_bom
psql -d syn_plm_bom -v ON_ERROR_STOP=1 -f 01-schema.sql
psql -d syn_plm_bom -v ON_ERROR_STOP=1 -f 02-seed-pull-1.sql
```

**PASS:** `01` prints 7 `CREATE TABLE` and 7 `CREATE INDEX`. `02` prints 7 `DELETE` lines, then
`INSERT 0 1` four times, `INSERT 0 7`, `INSERT 0 4`, `INSERT 0 7`. No errors from either. Sanity
check:

```sql
SELECT count(*) FROM dn_pdm_bomdetailsinfo;   -- 7  (6 after 03-seed-pull-2.sql)
SELECT count(*) FROM dn_pdm_partlibraryinfo;  -- 7
```

Note the lower-case names in that query: the DDL writes the read plan's own spelling
(`DN_PDM_BomDetailsInfo`) but leaves it **unquoted**, so Postgres folds it. That is deliberate — the
host adapter interpolates identifiers unquoted
(`packages/core-backend/src/data-adapters/PostgresAdapter.ts:173`, with
`packages/core-backend/src/data-adapters/BaseAdapter.ts:265-281`, which validates identifiers but
does not quote them), so both sides fold to the same lower-case name. The plugin then reads the
lower-case result keys through the case-insensitive fallback in
`plugins/plugin-integration-core/lib/stock-preparation-bom-expansion.cjs:353-361`.
**Do not add double quotes to the DDL** — the validation test refuses them.

The tables are created unqualified, so they land on the connection's first `search_path` schema
(normally `public`) and the **default read plan works verbatim**. To keep them in a dedicated
schema instead, create the schema and prefix the object names in the read-plan override
(section 2c) — the plan accepts one dot, e.g. `syn_plm.DN_PDM_PathExAttrInfo`.

## 2. Register it so the plugin can see it

Three layers, in order. None of them carries a database password into the plugin — the plugin only
ever holds a *pointer*.

### 2a. Host data source (this is where the connection lives)

`POST /api/data-sources` — payload schema at `packages/core-backend/src/routes/data-sources.ts:32-66`,
rbac `data_sources:write` at `:308`. Supported `type` values are frozen at
`packages/core-backend/src/data-adapters/DataSourceManager.ts:54-61` (`postgresql` / `postgres`,
`sqlserver`, `mysql`, `http`, `plm`); the Postgres driver is
`packages/core-backend/src/data-adapters/PostgresAdapter.ts`.

```json
{
  "id": "<your-data-source-id>",
  "name": "synthetic-plm-bom",
  "type": "postgresql",
  "connection": { "host": "<your-host>", "port": 5432, "database": "syn_plm_bom" },
  "credentials": { "username": "<read-only-user>", "password": "<password>" },
  "options": { "readOnly": true }
}
```

`readOnly` must not be `false`. The plugin facade refuses every call against a writable source
(`packages/core-backend/src/data-adapters/data-source-plugin-facade.ts:369-397`, with
`BaseAdapter.ts:495-497`), and it requires the calling principal to own the source.

**PASS:** the data source tests connected, and `GET`ing its schema lists the 7 tables.

### 2b. Integration external system (the pointer)

`POST /api/integration/external-systems` (route table `lib/http-routes.cjs:18`, handler `:2945-2953`;
`write` normally, `admin` if the body sets `config.lookupProjection`).

```json
{
  "id": "syn-plm-bom-source",
  "name": "Synthetic PLM BOM",
  "kind": "data-source:sql-readonly",
  "role": "source",
  "status": "active",
  "config": { "dataSourceId": "<your-data-source-id>" }
}
```

`config.dataSourceId` is the only required key
(`lib/adapters/data-source-sql-readonly-source-adapter.cjs:534`); `config.schema` is optional
(`:535`). There is deliberately no host/port/user/password here. The adapter kind is registered at
`plugins/plugin-integration-core/index.cjs:266`, and the dry-run/apply routes refuse a system whose
`kind` differs from the action's `source.kind` (`lib/http-routes.cjs:2852-2859`).

**PASS:** `GET /api/integration/external-systems/syn-plm-bom-source` returns `kind`
`data-source:sql-readonly` and `status` `active`.

### 2c. Table action config (env var)

Set `INTEGRATION_CORE_STOCK_PREPARATION_TABLE_ACTIONS_JSON` on the server. It is parsed at
`packages/core-backend/src/plugin-runtime-config.ts:2, :8-23` (a JSON **array or object**; anything
else throws), surfaced as `context.config.stockPreparationTableActions` (`:82-85`) and consumed at
`plugins/plugin-integration-core/lib/http-routes.cjs:2670-2675` →
`createStockPreparationTableActionRegistry` (`lib/stock-preparation-table-actions.cjs:264`).

```json
[
  {
    "actionId": "plm.stock-preparation.pull-bom.v1",
    "source": {
      "externalSystemId": "syn-plm-bom-source",
      "kind": "data-source:sql-readonly"
    },
    "target": {
      "sheetId": "<your-sandbox-sheet-id>",
      "objectId": "<your-sandbox-object-id>"
    }
  }
]
```

`actionId` must be exactly `plm.stock-preparation.pull-bom.v1`
(`lib/stock-preparation-table-actions.cjs:42`; any other value is a 422 at `:162-165`).
`source.externalSystemId` and `target.sheetId` are the only required fields
(`:151`, `:121`); `source.readPlan` defaults to the 7-object plan, so **omit it and the fixture
works as-is**. `target.objectId` defaults to the production canonical object, which apply always
rejects — see step 5.

Optional read-plan override, if you renamed anything in the DDL (add it under `source.readPlan`;
`sourceKind` must match `source.kind`, `:142-149`):

```json
{
  "sourceKind": "data-source:sql-readonly",
  "matchField": "FileCode",
  "pathExAttr": { "object": "DN_PDM_PathExAttrInfo", "matchField": "FileCode", "pathIdField": "Parent_OBJ_ID" },
  "pathInfo": { "object": "DN_PDM_PathInfo", "idField": "OBJ_ID" },
  "orderHead": { "object": "DN_PDM_OrderHeadInfo", "idField": "OBJ_ID", "pathIdField": "path_id" },
  "orderDetail": { "object": "DN_PDM_OrderDetailInfo", "orderIdField": "order_id", "componentIdField": "part_id", "quantityField": "quantity", "sortField": "sort_id" },
  "part": { "object": "DN_PDM_PartLibraryInfo", "idField": "OBJ_ID", "codeField": "IdentityNo", "nameField": "IdentityName", "materialField": "Material", "versionField": "SysVer" },
  "bomHead": { "object": "DN_PDM_BomHeadInfo", "parentPartField": "part_id", "bomIdField": "bom_id", "versionField": "SysVer", "activeField": "bom_able" },
  "bomDetail": { "object": "DN_PDM_BomDetailsInfo", "bomParentField": "bom_pid", "componentIdField": "part_id", "quantityField": "Bom_ExAttr1", "sortField": "sort_id" }
}
```

Every `object` and every `*Field` above is **plan-configurable**. What is *not* configurable:
the 7-object traversal graph itself, the rule that `matchField` must equal `pathExAttr.matchField`
(`lib/stock-preparation-bom-expansion.cjs:229-233`), which members are required vs optional
(`:221-227` — optional are `orderDetail.sortField`, `bomDetail.sortField`,
`part.codeField/nameField/materialField/versionField`, `bomHead.versionField/activeField`), the
`sourceKind` allowlist (`:21-24`), and the emitted MetaSheet row field names, which are frozen by
`lib/stock-preparation-templates.cjs:522-593`.

**PASS:** `GET /api/integration/table-actions` (`lib/http-routes.cjs:55`, handler `:3849-3855`)
returns the action with `configured: true`.

## 3. Dry run — pull #1

```
POST /api/integration/table-actions/plm.stock-preparation.pull-bom.v1/dry-run
```

Route `lib/http-routes.cjs:56`, handler `:3857-3876`. Requires `read`
(`requireAccess(req, 'read')` at `:3858`; permission model at `:520-528`, `:541-550`). The body
accepts **only** `parameters` and `conflictPolicyReview` (`VALID_TABLE_ACTION_DRY_RUN_BODY_KEYS` at
`:819`), and `parameters` accepts **only** `projectNo`
(`lib/stock-preparation-table-actions.cjs:289-304`).

```json
{ "parameters": { "projectNo": "SYN-PROJ-0001" } }
```

Response shape: `lib/stock-preparation-table-actions.cjs:813-831`.

**PASS (target sheet empty):**

- `status` is not `not_found`, `largeBom` is `false`
- `counts` = `{ "add": 7, "update": 0, "skip": 0, "inactive": 0, "manual_confirm": 0 }`
- `canApply` is `true` and `dryRunToken` is a non-null string (minted only when `canApply`, `:804-812`)
- `evidence.expansion.rowsExpanded` is `7`, `evidence.expansion.readObjects` lists all 7 tables

**FAIL signatures worth recognising:**

- `counts.manual_confirm > 0` → the plan holds; read `evidence.plan.conflictTypes`
- `status: "not_found"` → `DN_PDM_PathExAttrInfo` has no row for `SYN-PROJ-0001` (seed not loaded,
  or the tables landed in a schema that is not on the connection's `search_path`)
- `errorTypes` containing `read_failed` → the identifier did not resolve; you probably quoted the
  DDL identifiers

## 4. Dry run — pull #2 (refresh / preserve)

Apply pull #1 first (step 5), then:

```bash
psql -d syn_plm_bom -v ON_ERROR_STOP=1 -f 03-seed-pull-2.sql
```

and repeat the same dry-run call.

**PASS:** `counts` = `{ "add": 0, "update": 3, "skip": 3, "inactive": 1, "manual_confirm": 0 }`,
`canApply` is `true`.

Reading that: the sub-assembly quantity moved `1 → 3`, which rolls up into three `update`
decisions (`rawQuantity` / `totalQuantity` only); three rows are byte-identical and `skip`; the
deleted leaf line becomes `inactive` rather than a delete, because `missingFromPlmPolicy` is pinned
to `mark_inactive` (`lib/stock-preparation-conflict-planner.cjs:151-162`). Any value a human typed
into the sheet (`materialType`, `blankType`, `stockPreparationStatus`, `demandDate`,
`leadTimeDays`, `notes`, `procurementReply`, `warehouseConfirmation`) appears in **no** patch.

## 5. Apply

```
POST /api/integration/table-actions/plm.stock-preparation.pull-bom.v1/apply
```

Route `lib/http-routes.cjs:58`, handler `:3933-3962`. Requires `write` (`:3934`). Body accepts only
`parameters` and `confirm` (`VALID_TABLE_ACTION_APPLY_BODY_KEYS` at `:821`).

```json
{
  "parameters": { "projectNo": "SYN-PROJ-0001" },
  "confirm": { "dryRunToken": "<token from step 3>" }
}
```

Apply recomputes the plan and compares revisions, so **the token must come from a dry run against
the current source state** — a stale token is a 409 `TABLE_ACTION_DRY_RUN_TOKEN_MISMATCH`
(`lib/stock-preparation-table-actions.cjs:1004-1006`). There is no idempotency-key field on this
route. Other 409s: `TABLE_ACTION_DRY_RUN_NOT_APPLYABLE` (`:1007-1009`),
`TABLE_ACTION_MANUAL_CONFIRM_REQUIRED` (`:1010-1012`),
`TABLE_ACTION_DUPLICATE_RESOLUTION_REVIEW_REQUIRED` (`:1013-1016`).

**Before anything is written, the sandbox gate runs** (`assertStockPrepApplyAllowed`, called at
`:973-979`, i.e. before the token is consumed). It is fail-closed:

- the production canonical target object is **never** appliable on this path — `403`
  `STOCK_PREP_APPLY_SANDBOX_ONLY` with `reason: "prod_canonical"` (`:880-889`). Since `target.objectId`
  *defaults* to that canonical object (`:122`), you must set an explicit sandbox `objectId`;
- `STOCK_PREP_SANDBOX_MODE=true` must be set, and the target `objectId` must be listed in
  `STOCK_PREP_SANDBOX_TARGET_OBJECT_IDS` (comma-separated) — resolver at `:903-917`;
- production apply is a **separate owner gate**, server-config-only via
  `context.config.stockPrepApplyProduction`, with deliberately no env switch (`:923-928`).

**PASS:** HTTP 200 with `status` from the writer, `dryRunRevision` equal to the revision the dry run
returned, and `apply` counts matching the dry-run `counts`. Response shape at `:1033-1054`.

## 6. Optional: the duplicate-expanded-key hold

```bash
psql -d syn_plm_bom -v ON_ERROR_STOP=1 -f 02-seed-pull-1.sql
psql -d syn_plm_bom -v ON_ERROR_STOP=1 -f 04-optional-duplicate-expanded-key.sql
```

**PASS (this one is supposed to be red):** `counts` =
`{ "add": 7, "update": 0, "skip": 0, "inactive": 0, "manual_confirm": 1 }`, `canApply` is `false`,
no `dryRunToken`, and `evidence.plan.conflictTypes` contains `duplicate_expanded_key`.

Two things worth being precise about:

- **A component under two parents is NOT this case.** The idempotency key is
  `{ projectNo, componentSourceId, parentSourceId, path }`
  (`lib/stock-preparation-bom-expansion.cjs:401-408`), so `SYN-PART-LEAF-D` under both
  `SYN-PART-SUB-B` and `SYN-PART-SUB-C` — which is already in `02-seed-pull-1.sql` — produces two
  distinct keys and two clean `add` decisions. Only a repeat under the **same** parent collides.
  That is why the collision needs its own file.
- **`CONFLICT_POLICY_NOT_IMPLEMENTED` is not reachable from data.** With no policy review the group
  holds under reason `default_hold` (`lib/stock-preparation-conflict-planner.cjs:663-667`). The 422
  `CONFLICT_POLICY_NOT_IMPLEMENTED` is a *selection* refusal: it fires when an operator chooses
  `merge_quantity`, `select_representative` or `skip_selected`
  (`lib/stock-preparation-conflict-policies.cjs:119-137`), because each alters a business quantity
  (`lib/stock-preparation-conflict-planner.cjs:682-687`). The only policy that resolves the group is
  `keep_multiple_rows` (`:64`); the two lines carry distinct `sort_id` values so that policy has a
  stable discriminator (`:78-82`).

Re-run `02-seed-pull-1.sql` to get back to the clean state.

## 7. Optional: folder-subtree root discovery (`readPlan.projectSubtree`)

```bash
psql -d syn_plm_bom -v ON_ERROR_STOP=1 -f 02-seed-pull-1.sql
psql -d syn_plm_bom -v ON_ERROR_STOP=1 -f 05-seed-subtree-roots.sql
```

This one takes a **configuration** change as well as data, and that is the point: `projectSubtree`
is not in the shipped read plan, so loading the seed alone changes nothing at all. Add the block to
the action's `source.readPlan` (via `INTEGRATION_CORE_STOCK_PREPARATION_TABLE_ACTIONS_JSON`):

```json
{
  "maxReadCount": 500,
  "projectSubtree": {
    "pathInfo": { "parentIdField": "Parent_OBJ_ID" },
    "bomHead":  { "pathIdField": "path_id" }
  }
}
```

`maxReadCount` is **mandatory** here — normalization refuses an enabling plan without one, because
the folder traversal plus one BOM per discovered root is a real read amplification and the ceiling
has to be a number somebody chose.

**PASS with the block OFF:** byte-identical to §3 — 7 rows, the same reads in the same order. The
two columns this seed populates (`DN_PDM_PathInfo.Parent_OBJ_ID`, `DN_PDM_BomHeadInfo.path_id`) are
read by nothing in the default plan.

**PASS with the block ON:** 10 rows. The extra three are `SYN-PART-SUBTREE-H` (a part in **no**
order line, discovered through folder node `SYN-PATH-1-SUB`) at depth 0 with
`rawQuantity = totalQuantity = 1`, plus its two children. `summary.subtree` reads
`{ nodesVisited: 2, nodesSkippedAlreadyVisited: 0, rootsDiscovered: 1, rootsExpanded: 1, rootsSkippedAlreadyExpanded: 0,
rootsWithoutChildren: 0, rootQuantitySource: { orderDetail: 1, subtreeDefault: 1 } }`, and the plan
is still valid (`add: 10`).

Two things this seed is shaped to prove:

- **A defaulted root quantity is counted, not disguised.** A folder-discovered root has no order
  line and therefore no measured quantity. The row carries the neutral multiplier `1`, which in the
  target table is indistinguishable from a measured `1` — so `rootQuantitySource` in the evidence is
  the only place that distinction survives. Read it before treating those rows as procurement
  quantities.
- **Two BOM heads on one `part_id` are ONE root.** `SYN-PART-SUBTREE-H` has both `SYN-BOM-H` (V1)
  and the superseded `SYN-BOM-H-V0` on the same folder node. Two roots would carry byte-identical
  idempotency keys, which the planner groups and holds — the whole plan would go `manual_confirm`.

Re-run `02-seed-pull-1.sql` to get back to the clean state.

---

## What this fixture exercises

| Planner case | Covered | Where |
| --- | --- | --- |
| Multi-level assembly (`path` / `depth` non-trivial) | yes | pull #1, depths 0–2 |
| Quantity roll-up across levels | yes | 2 → 6 → 24 |
| Component under two parents (distinct keys, both `add`) | yes | `SYN-PART-LEAF-D` |
| Inactive BOM head filtered out (`bom_able = '0'`) | yes | `SYN-BOM-C-RETIRED` / `SYN-PART-LEAF-G` |
| PLM-owned refresh → `update` | yes | pull #2, quantity change |
| Unchanged row → `skip` | yes | pull #2, 3 rows |
| Row disappears → `mark_inactive` | yes | pull #2, `SYN-PART-LEAF-F` |
| Human-preserved cells untouched | yes | asserted in the guard test |
| Duplicate expanded key → `manual_confirm` | opt-in | `04-…sql` |
| Folder-subtree root discovery (optional block) | opt-in | `05-…sql` + `projectSubtree` in the plan |
| Pagination / cursor loop | partly | guard test runs with `pageLimit: 2` |

## What it deliberately does not cover

Each of these needs its own fixture and would make the happy path red:

- `component_identity_conflict` and `lineage_mismatch` — changing `IdentityNo`, `IdentityName`,
  `Material` or `SysVer` between pulls holds the row for manual confirmation instead of updating it
  (`lib/stock-preparation-conflict-planner.cjs:33-45`); pull #2 keeps them fixed on purpose.
- `cycle_detected`, `max_depth_exceeded`, `max_rows_exceeded`, and the large-BOM bounded-preview
  path — the dataset is tens of rows by design.
- `ambiguous_path` / `ambiguous_component` (duplicate `OBJ_ID`), `missing_component`,
  `missing_bom_id`, `missing_child_bom` (a head with no detail lines), `invalid_quantity`.
- `duplicate_existing_key` — a target-side condition, not a source-side one.
- Resolving the duplicate group with `keep_multiple_rows`, which needs a `conflictPolicyReview` in
  the request body, not different data.
- The ERP/K3 material side, the MVP snapshot tables, and the large-BOM job routes.

## What a live run still has to prove

The guard test is static and in-memory. It cannot and does not verify:

1. **That the host `data_sources` → plugin facade → adapter chain resolves at all** against a real
   Postgres — credentials, read-only enforcement, principal ownership, TLS.
2. **Identifier folding end to end.** The unquoted-identifier behaviour is read off
   `PostgresAdapter.ts:173` + `BaseAdapter.ts:265-281`; the fixture is built for it, but no query
   has actually been issued here.
3. **`numeric` → JS.** The guard models node-postgres returning `numeric` as a scaled string
   (`'2.000000'`), which is the documented default, but the real driver/pool config is not observed.
4. **Cursor/pagination semantics of the real adapter.** The guard uses its own offset paging; the
   adapter's offset cursor (`lib/adapters/data-source-sql-readonly-source-adapter.cjs:295-305`) and
   the host `LIMIT`/`OFFSET` composition are unexercised.
5. **The apply write itself** — the multitable records API, `target.fieldIdMap` translation, and the
   sandbox/production gates have not been run against a live target sheet.
6. **Route wiring, auth and env gating** — every route contract above is cited from source, not
   observed over HTTP.

No database was available while this fixture was written, so items 1–6 are open by construction.
Everything under "what this fixture exercises" *is* verified statically, against the real expander
and the real planner, by `__tests__/stock-preparation-synthetic-sql-fixture.test.cjs`.
