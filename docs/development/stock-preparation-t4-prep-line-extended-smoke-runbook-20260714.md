# Stock-preparation T4 prep-line extended smoke runbook

**Date:** 2026-07-14

**Status:** PREPARED. This runbook does **not** claim a deployed-environment PASS. It is the
operator checklist for dispatching the T4 extended smoke against a deployed environment (the
closeout §5b Wave-3 gate input). A full local rehearsal (real fresh-migrated Postgres + the real
core-backend server + this harness over real HTTP) has passed; the deployed-lane run is recorded
in the section at the bottom only when it actually happens.

**Scope (closeout §5b, `stock-preparation-mvp-closeout-and-verification-20260712.md`):** T4 is the
non-empty prep-line extended smoke — it drives the internal chain
cache → auto-match → unit-conversion → generation → exception → audit to a **non-empty**
prep-line table and the **full `ready:true` flip**, which the W6 postdeploy smoke deliberately
could not reach before T2 (#4206) landed the internal ERP material-master cache route.

It does not add runtime code, open any value-bearing read (OD-W3-1 stays closed), touch any
permission/RBAC layer, or call any external PLM/K3/ERP system. `externalWrite` stays `false`:
every write lands in the 9 internal MVP tables through the pre-existing admin-gated HTTP surface.

## What This Proves

One dispatch of `scripts/ops/stock-preparation-prep-line-extended-smoke.mjs` proves, over real
HTTP, with a per-run-salted self-contained fixture (3 BOM lines A/B/C):

1. **project endpoint PASS** — the persisted project appears in `GET /projects`, values-free
   (no `projectName` / `sourceProjectNo` key ever crosses).
2. **ERP cache rows > 0** — `POST /mvp/erp-materials/sync` (T2) caches a material whose
   `erpMaterialCode` equals BOM drawing A.
3. **auto-match consumed the cache** — `candidates/sync` yields EXACTLY ONE
   `exact_code_candidate` with an ERP target (drawing A) and two `not_found` rows (B, C);
   confirming the candidate BY `mappingId` keeps `matchMethod=exact_code_candidate`
   (the cache row was confirmed, not replaced).
4. **prepLineRows > 0** — generation run 1 returns `201 partial` with `created.lines=1`
   (the non-empty proof on the FIRST run) plus 2 blocking `missing_mapping` exceptions;
   `GET /prep-lines` rowCount=1 under the closed values-free 10-key projection.
5. **exception lane** — caching B+C refreshes the candidate ladder (re-sync creates 2 NEW
   exact-code candidates; A re-emits historical and is skipped), both confirmed by id; one
   exception resolved via the single route, one via same-reason bulk (`mapping_confirmed`).
6. **the full ready flip** — generation run 2 returns `status=ready`, `ready=true`,
   unresolved-blocking `2 → 0`, 3/3 prep lines matched + converted, with the human resolutions
   preserved by the create-only re-run; the server-side ready invariant holds on both runs.
7. **audit 8/8** — all eight closed-vocabulary actions left a values-free row scoped to the
   fixture project.
8. **fail-closed probes** — confirm-by-id on a no-ERP-identity candidate →
   `409 CONFIRM_MAPPING_TARGET_INCOMPLETE`; a body `tenantId` on the T2 route →
   `400` closed-allowlist rejection (anti-steering).
9. **values-free discipline** — every non-exempt response body is leak-scanned against the
   fixture + engine-message sentinels (the only exempt response is the `/mvp/sync/plan`
   same-origin echo, counted and pinned at exactly 1), and the harness self-scans its own
   output before emitting it (P2-2, inherited from the W6 smoke).
10. **cleanup** — all 5 mapping rows and the unit rule are retired; the 3 cached materials are
    re-synced to `materialStatus=inactive` (which is ALSO the T2 upsert-patch proof:
    `refreshed`, `patched {materials:3}`, zero creates). Project-scoped batch / lines /
    prep-lines / exceptions stay, as immutable audit substrate (same posture as the W6 smoke).

## Prerequisites

1. A deployed main build that includes T1 (#4190, `GET /projects`) and T2 (#4206,
   `POST /mvp/erp-materials/sync`).
2. The same repo secrets/vars the W6 lane uses (`METASHEET_K3WISE_SMOKE_TOKEN` or the
   DEPLOY_* token-resolver path, `METASHEET_BASE_URL` / `METASHEET_TENANT_ID` vars).
3. **Serial run** — do not dispatch concurrently with the W6 postdeploy smoke lane or a second
   T4 dispatch: candidate-id attribution diffs TENANT-level lists. The workflow's concurrency
   group serializes T4 with itself; the cross-lane rule is operator discipline.

## Dispatch

- GitHub Actions → `Stock Preparation Prep-Line Extended Smoke` → Run workflow
  (optionally override `base_url` / `tenant_id` / `workspace_id` / `project_prefix` /
  `timeout_ms`). The deployed job runs only on `workflow_dispatch`; pull requests run the
  no-server contract tests.
- Manual equivalent:

  ```bash
  METASHEET_AUTH_TOKEN=... node scripts/ops/stock-preparation-prep-line-extended-smoke.mjs \
    --base-url http://HOST:PORT --tenant-id TENANT --out-dir output/t4
  ```

- PASS = exit 0 and a summary block ending `pass=true` with `auditActionsCovered=8/8`,
  `leakScanClean=true`, `selfScanClean=true`, `externalWrite=false`. Evidence artifacts
  (`summary.txt`, `checks.json`) are values-free by construction.
- An aborted / cancelled run can leave its salted candidate rows active (they are inert to
  every other run — all join keys are per-run salted); a COMPLETED run retires everything
  tenant-level it created.

## Local rehearsal recipe (what was actually run, 2026-07-14)

Full-chain rehearsal on a real fresh-migrated Postgres and the real server — not a fake:

```bash
createdb stockprep_t4_smoke
DATABASE_URL='postgresql://<user>@localhost:5432/stockprep_t4_smoke?sslmode=disable' \
  NODE_ENV=production DB_SSL=false JWT_SECRET='<32+ chars>' \
  pnpm --filter @metasheet/core-backend db:migrate
# real server, all plugins loaded (RBAC_TOKEN_TRUST is the documented non-production
# trusted-claims path; it never applies to production builds):
DATABASE_URL=... NODE_ENV=development DB_SSL=false JWT_SECRET=... RBAC_TOKEN_TRUST=true \
  PORT=3999 pnpm --filter @metasheet/core-backend exec tsx src/index.ts
# admin token minted from the same JWT_SECRET with roles:['admin'], tenantId
METASHEET_AUTH_TOKEN=... node scripts/ops/stock-preparation-prep-line-extended-smoke.mjs \
  --base-url http://127.0.0.1:3999 --tenant-id t4smoke --out-dir output/t4
```

Result: `pass=true`, 58/58 checks, `run1 created.lines=1` (non-empty), `run2 status=ready
ready=true` with the `2 → 0` unresolved-blocking flip, `prepLines2RowCount=3` (3/3
matched + converted), `auditActionsCovered=8/8`, 46 responses leak-scanned clean, cleanup
`retiredMappings=5` + rule retired + `erpRetireMode=refreshed patched materials:3`, and 3 rows
physically present in the internal `Stock Preparation Line` sheet (`meta_records`).

## Deployed-lane PASS record

_None yet. Record the workflow run URL + summary block here after the first deployed dispatch._

## T4-final：approved-source 前置（T3b OD-6 扩展，2026-07-16）

可选前置，把「approved PLM read → 同请求内部落库」接到本 smoke 前端；合成链判据原样保留（扩展而非重写）。

### 前提（operator 提供，smoke 不自造）
1. 一份 **approved** read-source config（`readSourceConfigId` 引用即可，smoke 绝不携带凭证或 raw payload 控制）。其 `fieldMap.target` 只允许 bounded 结构目标（如 `pathKey`/`childDrawingNo`/`designQty`）；**不得**映射 `missingChildBom`（T3b 结构守卫会 422 `CONFIG_TARGET_FORBIDDEN`），映射 `status`/`lineStatus` 时上游值必须已是 `imported/active/inactive/incomplete` 词表（否则整包 422 `LINE_STATUS_UNSUPPORTED`）。
2. 服务侧 **临时** 打开 `MULTITABLE_STOCK_PREP_PLM_AUTOPERSIST_ENABLED=true`：开 → 跑一次 → 恢复 OFF。**禁止**把该 flag 写入任何生产模板（OD-1/OD-6）。

### 运行
```
node scripts/ops/stock-preparation-prep-line-extended-smoke.mjs \
  --base-url http://HOST:PORT ... --approved-source-config-id <cfg_ref>
```
（或 workflow_dispatch 输入 `approved_source_config_id`。）

### 判据（全部 values-free）
- `approvedSourceHttp=201`、`approvedSourceMode=internal_persist`、created 计数 `batch:1 / lines>=1 / run:1`；
- 外写不变量全 false（`externalWriteExecuted/productionWrite/k3SaveSubmitAudit/plmExternalWrite`）；
- exact replay：`approvedSourceReplayHttp=200`、`approvedSourceReplayMode=internal_noop`、`skipped_existing`、零增行；
- flag OFF 时该前置**必失败**（200 dry_run 不满足 201 internal_persist 判据），不会被静默当作通过；
- 前置请求**不带任何 query 载体**（ON 路径把 query `tenantId/projectId` 视为 steering 并 fail-close；租户只随认证 token）；
- config 引用与请求中的值面 token（sourceProjectNo/projectName）注册为泄漏哨兵，响应命中即整跑 FAIL。

不带 `--approved-source-config-id` 时，本 smoke 与 T4-final 之前逐字节等价（无新增请求、无新增 summary 键）。
