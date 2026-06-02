# Data-source → Data Factory convergence — execution plan + gated TODO (2026-06-01)

> Companion to the design `data-factory-sql-data-source-readonly-source-bridge-design-20260601.md`
> (PR #2185, merged `25cf5deb3`). This file is the **execution ordering + trackable checklist**, not an
> authorization to build.
> Markers: ✅ done · ⬜ open / ready (still needs its own opt-in) · 🔒 gated (blocked on a prior gate
> AND a separate explicit opt-in).
>
> **Constraints (non-negotiable):** post-GATE **scoped, read-only** opt-ins — each phase below is a
> **separate named opt-in**, never auto-start the next. The bridge stays **read-only** and **does not
> touch the K3 channel / central RBAC / auth**. The two UIs stay separate until C4. Formal docs state
> our own principles, not external brand names.

## The thesis (why this track exists)

The generic data-source connector stack (`data-adapters/* + DataSourceManager + routes/data-sources.ts`)
and the Data Factory stack (`plugins/plugin-integration-core/lib/*`) are **independent in code by
design** and stay that way. But the 阶段二 hub thesis — *import source-adapter → multitable → export
target-adapter* — means a generic **read-only** SQL connector **is** an import source-adapter. This track
**builds the thin additive bridge** that lets the Data Factory consume one read-only SQL data source as a
pipeline source. It is **parallel to the K3 line** (it touches no K3 surface) and proves the hub with a
real generic source.

## Relationship to the other ladders (so this isn't confused with them)

- **K3 DF line** (DF-T3b-2c real-Save, etc.) — separate, gated on the operator-validation run. This
  bridge does **not** advance or depend on it.
- **data-sources connector track** — essentially closed (A0–A6 / B1–B5 / C1–C3 / UI all landed). This
  bridge **consumes** it read-only; it adds no new data-sources capability.
- This convergence track is the **first realization of the generic hub** beyond K3 / staging / multitable.

## Phase ladder (gated)

### ✅ C0 — Design (DONE — PR #2185, `25cf5deb3`)
- [x] `data-source:sql-readonly` read-only source adapter design; mirrors `metasheet-staging-source-adapter.cjs`'s offset-cursor pattern over an injected host capability.
- [x] Three seams locked: (1) host→plugin **narrow read-only facade** `context.api.dataSources` (NOT the full `DataSourceManager`); (2) **owner-scope** via `assertAccess` using `pipeline.createdBy` (run) / request-user (direct), **fail-closed**, no fallback; (3) **read v1 = full/manual offset paging**, 10k/page cap, `maxPages` fail-closed, watermark deferred.
- [x] Guardrails + 9-item acceptance checklist recorded; owner-principal seam corrected to the real `integration_pipelines.created_by` (external-system has no owner column).

### ⬜ C1 — Impl-1: backend adapter + read-only facade (latent)
The first buildable slice. **Latent**: registered + unit-tested, but **no pipeline auto-created** and no UI. Backend-only, integration-core (scoped, read-only opt-in).

Work items:
- [ ] **Host read-only facade** `context.api.dataSources = { test(id,principal), getSchema(id,principal), getTableInfo(id,object,principal), select(id,table,{limit,offset},principal) }` — a thin pass-through to `DataSourceManager.getSchema/select`; **no** create/update/delete/credentials/rotate/connect method exposed. Injected via the plugin context (same pattern as `context.api.multitable.records`).
- [ ] **The adapter** `data-source:sql-readonly` (mirror `metasheet-staging-source-adapter.cjs`): `testConnection / listObjects / getSchema / read`; `upsert` → throw `NotSupported`. `read({object,limit,cursor})` → `offset = parseOffsetCursor(cursor)` → `facade.select(...)` → `{records, nextCursor, done}` (`done` when rows < limit).
- [ ] **Owner-principal wiring** (the load-bearing seam — the runner references `created_by` nowhere today): thread `pipeline.createdBy` (loaded via `pipelines.cjs:302`) on a run, or the request user for direct test/schema, into the facade's `assertAccess`. Missing principal → **fail-closed config error** (no fallback to system/tenant/workspace/admin/service).
- [ ] **External-system row shape**: `kind='data-source:sql-readonly'`, `role='source'`, `config={ dataSourceId, object?, schema? }`, `capabilities={read:true, introspect:true, write:false, watermarkFields:[]}`. **No credentials** stored on the integration row — only the `dataSourceId` reference.
- [ ] **Registration** at `index.cjs` adapter registry.

Acceptance locks (each a test, several with a negative control):
- [ ] Contract conformance: `testConnection/listObjects/getSchema/read` work; `upsert` throws `NotSupported` (pipeline targeting this kind as a **target** is rejected).
- [ ] **Facade read-only by construction** — negative control: no write/CRUD/credential method is reachable from the plugin.
- [ ] **Run uses `pipeline.createdBy`** as the principal (not request user, not null) — asserted on a run.
- [ ] **Cross-owner read fail-closed** (`assertAccess` honored through the facade) — negative control: a non-owner principal → uniform "not found", no existence leak.
- [ ] **Missing principal fail-closed** — a NULL-`createdBy` pipeline → legible config error (distinct from "not found"); **no fallback** to system/tenant/workspace/admin — negative control.
- [ ] **Writable `data_sources` binding rejected** (read-only source only).
- [ ] Offset paging: full/manual page loop, fewer-than-limit ⇒ `done`; `maxPages` **fail-closed** (no silent truncation); stable-order required or single-page fail-closed.
- [ ] **No credentials** in config / preview / provenance / logs (redaction self-check).
- [ ] **No raw `/query`** (only structured `select`); **no K3** Save/Submit/Audit/BOM reachable.

### ⬜ C2 — Impl-2: workbench source-system wiring (frontend)
Gated on: C1 + opt-in. Frontend-only.
- [ ] Workbench "select source system" surfaces a `data-source:sql-readonly` system; pick the data source → object (table/view) → fields.
- [ ] Enters the **existing** dry-run / staging / provenance flow (no new pipeline machinery).
- [ ] **Reachability test**: author a source → dry-run → rows appear in staging/provenance — read-only, no write.
- [ ] `/data-sources` stays the sole connection/credential surface; the workbench **references** it (a `dataSourceId` picker), does not embed connection CRUD.

### 🔒 C3 — Incremental / watermark reads
Gated on: C1/C2 + a watermark-column convention + opt-in.
- [ ] A declared watermark field (e.g. `updated_at` / monotonic id) per source binding; map to `read({watermark})`; advance via the pipeline-runner watermark store. Until then, this source kind is **full/manual only**.

### 🔒 C4 — UI unification (only after the bridge runs stably)
Gated on: C2 proven in real use + opt-in; **design-first**.
- [ ] Decide whether the workbench gains inline data-source connection management or the two surfaces stay referenced-but-separate. Do **not** merge the windows before the bridge is stable.

### 🔒 C5 — K3 SQL Server channel onto the hardened generic MSSQL layer (the B0 axis)
Gated on: a decision to **productionize the K3 SQL Server channel** + opt-in. **Separate, riskier axis — it touches the K3 channel** (`k3-wise-sqlserver-*`), unlike C1–C4.
- [ ] Back the K3 channel's connection onto the shared/generic hardened MSSQL layer (the deprioritized **B0** shared helper) instead of its PoC new-pool-per-call executor — only when productionizing K3 SQL Server. Not part of the read-only bridge.

### 🔒 C6 — External-DB write (source as target)
Gated on: a named write use-case + its own security review + opt-in.
- [ ] Out of scope for the read-only bridge. A separate future capability (the bridge's `upsert` stays `NotSupported` until then).

## Cross-cutting invariants (every phase must hold)

- **Read-only by construction** — the facade exposes no write/CRUD/credential method; the adapter's `upsert` throws until C6.
- **Owner-scope fail-closed** — every read authorizes via `assertAccess` with a real principal (`pipeline.createdBy` / request-user); missing principal fails closed; never a system/admin fallback.
- **No credential copy** — credentials stay in `data_sources`; the integration row carries only `dataSourceId`; evidence passes shared redaction.
- **No K3 touch** (C1–C4) — generic source only; the K3 channel is untouched until the separate C5 axis.
- **UIs separate until C4** — the workbench references `/data-sources`, does not absorb it.
- **Each phase a separate named opt-in** — never auto-start the next.

## Sequencing rule

One explicit opt-in per phase. Do not auto-start the next. **C0 (design) is DONE (#2185).** The next
buildable slice is **C1 (backend adapter + facade, latent)** — a separate explicit opt-in. C2 follows C1;
C3–C6 each stay 🔒 until their predecessor/decision is in place and they are separately opted in. This
track runs **parallel to the K3 line** and blocks nothing on it.

## Definition of done — C1 (the immediate buildable)

- The adapter + the narrow read-only facade are implemented and registered (latent — no pipeline
  auto-created), green in CI.
- Every acceptance lock above is covered by a test, and each guardrail that can regress has a **negative
  control** (facade-read-only, cross-owner, missing-principal/no-fallback, offset `maxPages`).
- No new data-sources capability; no K3 surface; no credential copy; read-only throughout. Landed under
  an explicit, scoped, read-only integration-core opt-in.
