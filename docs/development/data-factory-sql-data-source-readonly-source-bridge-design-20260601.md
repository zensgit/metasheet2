# Data Factory — read-only SQL data-source as a pipeline import source — design (2026-06-01)

> **Design-first. No runtime in this slice.** Brings a `data_sources`-registered **read-only** SQL
> connection (Postgres / SQL Server) into the Data Factory as a pipeline **source**, via a new
> read-only source adapter `data-source:sql-readonly` — **without merging the two stacks or copying
> credentials**. Post-GATE **scoped, read-only** opt-in; does **not** touch the K3 channel, central
> RBAC, or auth.

## Why — the convergence, sequenced (not a merge)

The generic data-source connector stack (`packages/core-backend/src/data-adapters/*` + `DataSourceManager` +
`routes/data-sources.ts`) and the Data Factory stack (`plugins/plugin-integration-core/lib/*`) are
**independent by design** and should stay decoupled in code. But the 阶段二 hub thesis —
*import source-adapter → multitable → export target-adapter* — means a generic SQL connector **is** an
import source-adapter. This is the **thin, additive bridge** that lets the Data Factory consume one
read-only SQL data source as a pipeline source: the first real import source beyond K3 / staging /
multitable. It is sequenced as parallel work that does not touch the K3 Save line.

## Scope boundary (the load-bearing sentence)

This adds **one** capability: expose an existing **read-only** `data_sources` SQL connection as a Data
Factory `source` system — list tables/views, introspect a table's columns, and paginate-read its rows
into the **existing** dry-run / staging / provenance flow.

It does **NOT**: write to the external DB (`upsert` unsupported); allow raw-SQL authoring; copy, store,
or surface credentials; touch the K3 Save / Submit / Audit / BOM path; merge the `/data-sources` and
Integration Workbench UIs; or do incremental / watermark reads.

## Grounded current state (verified on `origin/main`)

| | Generic data-source stack | Data Factory stack |
|---|---|---|
| Adapter contract | `connect/query/select/getSchema/...` (DB-like) | `testConnection/listObjects/getSchema/read/upsert` (`contracts.cjs:12`) |
| Read shape | `select({limit, offset})`, 10k/page hard cap (`BaseAdapter` `resolveEffectiveLimit`) | `read({object,limit,cursor,filters,watermark}) → {records,nextCursor,done}` (`normalizeReadRequest`, `contracts.cjs:91`) |
| Facade / scope | `DataSourceManager.select(id,…)` / `getSchema` (`DataSourceManager.ts:530`), owner-scoped `assertAccess(id,ownerId)` (`:301`) | external-system registry + adapter factory (`index.cjs:210`); `integration_external_systems` is tenant/workspace-scoped and has **no owner column** (migration 057:19), while `integration_pipelines.created_by` exists (migration 057:67) and is filled by the route from the current user (`http-routes.cjs:1073`) |
| Coupling today | **none** (one comment in `MSSQLAdapter.ts:2`) | — |

**The template to mirror:** `lib/adapters/metasheet-staging-source-adapter.cjs` is an *internal* source
adapter that already satisfies the contract using **offset-cursor pagination** (`parseOffsetCursor:201`)
over an **injected host capability** (`context.api.multitable.records`, `getRecordsApi:128`). This bridge
is the **same shape with the read backend swapped** — internal multitable records → the read-only
data-source facade.

## The adapter — `data-source:sql-readonly`

Mirror the staging source adapter (`createMetaSheetStagingSourceAdapter:223`). Contract mapping:

| Contract method | Behavior |
|---|---|
| `testConnection()` | facade `test(dataSourceId)` (or a `getSchema` round-trip); returns ok/latency/redacted-error |
| `listObjects()` | facade `getSchema(dataSourceId)` → `tables[] + views[]` |
| `getSchema({object})` | facade `getTableInfo(dataSourceId, object)` → `fields[]` (name/type/nullable) |
| `read({object,limit,cursor})` | `offset = parseOffsetCursor(cursor)`; facade `select(dataSourceId, object, {limit, offset})`; return `{records, nextCursor, done}` (`done` when rows < limit) |
| `upsert(...)` | **throw `NotSupported`** — read-only source |

External-system row: `kind='data-source:sql-readonly'`, `role='source'`,
`config={ dataSourceId, object?, schema? }`, `capabilities={read:true, introspect:true, write:false, watermarkFields:[]}`.
**No `credentials_encrypted` on the integration row** — only the `dataSourceId` reference; credentials
stay in `data_sources`.

## The three locked seams

### Seam 1 — host→plugin **read-only facade** (reuse the existing capability-injection pattern)

The bridge must **not** receive the full `DataSourceManager`. The host injects a **narrow read-only
facade** as a plugin capability — exactly how `context.api.multitable.records` is injected today:

```
context.api.dataSources = {
  test(dataSourceId, principal),                                  // connection check
  getSchema(dataSourceId, principal),                             // tables/views + columns
  getTableInfo(dataSourceId, object, principal),                  // columns of one object
  select(dataSourceId, table, { limit, offset }, principal),      // bounded rows
}
```

- **Read-only by construction:** no `create/update/delete/credentials/rotate/connect` method is exposed.
  The integration plugin can therefore never gain CRUD or credential power over data sources.
- Thin pass-through to `DataSourceManager.getSchema/select` (`DataSourceManager.ts:530`) — **not** a
  re-implementation, and **not** a second connection pool.
- This is the **first intentional host→plugin data capability beyond multitable**; keeping it read-only
  is the invariant that makes the whole bridge safe.

### Seam 2 — scope / ownership reconciliation (fail-closed)

data-sources is **owner-scoped** (`assertAccess(id, ownerId)`, `DataSourceManager.ts:301`); the Data
Factory external-system registry is workspace/tenant-scoped and **does not currently store an owner**
(`integration_external_systems` has tenant/workspace/project, but no owner column). The durable owner
principal available to the run is the pipeline's `createdBy` value, written from the current request
user when the pipeline is created (`http-routes.cjs:1073`) and stored in `integration_pipelines.created_by`
(`migration 057:67`). Decision:

- The facade is invoked with the **pipeline owner principal** (`pipeline.createdBy`, or the current
  request user for direct external-system test/schema calls before a pipeline exists) and forwards it to
  `assertAccess` — so a pipeline can read a data source **only if the pipeline owner owns that source**
  (an explicit cross-owner grant is **deferred**, out of scope).
- Missing owner principal is a configuration error and **fails closed**. Impl-1 must not fall back to
  `system`, tenant id, workspace id, or an admin/service principal, because that would bypass
  `data_sources.owner_id`.
- On mismatch, `assertAccess` throws the uniform *"not found"* → the bridge surfaces a clean connection
  error and **never leaks existence**. No cross-owner read.
- The referenced `data_sources` row must be **`readOnly` (default true)**; the bridge **refuses a
  writable source binding** (defense-in-depth — this is a read-only source).

### Seam 3 — read model v1 = **full / manual only** (offset paging; no watermark)

- data-sources offers `select(limit/offset)` with a hard **10k-row/page cap** (`resolveEffectiveLimit`)
  and has **no watermark / CDC**.
- The bridge `read({limit, cursor})` maps `cursor → offset` (reuse the staging adapter's
  `parseOffsetCursor` discipline), calls `facade.select(..., {limit, offset})`, and returns
  `{records, nextCursor, done}` — `done` when a page returns fewer than `limit` rows. The pipeline-runner
  **page loop** drives it, bounded by the pipeline's `maxPages` and **fail-closed on overflow**
  (no silent truncation — mirror `bulkReadRows`, `reference-mapping-source.cjs:21`).
- Pipeline `mode` for this source kind is restricted to **full / manual**. **Incremental + watermark are
  deferred** until a watermark-column convention exists.
- **Deterministic paging:** offset paging is only correct under a stable order, so each page read must
  order by a stable key (primary key / first column). If none is resolvable, the source declares
  **single-page-only** and caps at one bounded page (fail-closed) rather than risk duplicate/missing rows.

## Guardrails / invariants (each gets a negative control at impl time)

- `upsert` throws `NotSupported` — a pipeline using this kind as a **target** is rejected.
- The bridge holds **no** credentials and exposes none in config / preview / provenance / logs (only
  `dataSourceId`); shared redaction self-check passes.
- **No raw `/query`** path — only structured `select` via the facade.
- A **writable** `data_sources` binding is rejected (read-only source only).
- Cross-owner read is **fail-closed** (`assertAccess` honored through the facade).
- **No K3** Save / Submit / Audit / BOM is reachable from this source kind — it is a generic source only.

## Phased decomposition (each a separate explicit opt-in)

- ✅ **Design** (this document).
- ⬜ **Impl-1 (backend):** the `data-source:sql-readonly` adapter + the host read-only facade
  (`context.api.dataSources`) injection + registry registration (`index.cjs:210`), unit-tested for
  contract conformance **and** every guardrail negative control. No UI.
- ⬜ **Impl-2 (frontend):** the Integration Workbench shows it as a source system (pick data source →
  object → fields), entering the **existing** dry-run / staging / provenance flow. Frontend-only.
- 🔒 **Deferred:** incremental / watermark reads · UI unification of `/data-sources` + workbench ·
  external-DB write · reuse of the hardened generic MSSQL connection layer by the K3 SQL Server channel
  (a **separate, riskier axis** — it touches the K3 channel, scoped-gated, only when productionizing K3
  SQL Server).

## Acceptance checklist (the locks)

- ⬜ Contract conformance: `testConnection / listObjects / getSchema / read` implemented; `upsert` throws `NotSupported`.
- ⬜ Host facade is **read-only by construction** — negative control: no write/CRUD/credential method is reachable from the plugin.
- ⬜ Cross-owner read **fail-closed** (`assertAccess` honored through the facade) — negative control.
- ⬜ Missing pipeline/current-user owner principal **fails closed** — no fallback to `system`, tenant,
  workspace, or service/admin principal.
- ⬜ **Writable** `data_sources` binding rejected (read-only source only).
- ⬜ Offset paging: full/manual page loop, fewer-than-limit ⇒ `done`; `maxPages` **fail-closed** (no silent truncation).
- ⬜ **No credentials** in config / preview / provenance / logs (redaction self-check).
- ⬜ **No raw `/query`**; only structured `select`.
- ⬜ **No K3** write surface reachable from this source kind.
- ⬜ Deterministic-order requirement enforced (stable key) or single-page fail-closed.

## Gating posture

New integration-core surface → post-GATE **scoped, read-only opt-in** (named, **not** auto-start).
Read-only, no K3 surface, no RBAC/auth touch ⇒ low-risk scoped gate. Each Impl slice above is its own
explicit opt-in; Impl-1 (backend, latent — adapter + facade, registered but no pipeline auto-created)
before Impl-2 (workbench wiring).
