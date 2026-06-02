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

### 🟢 C1 — Impl-1: backend adapter + read-only facade (latent) — BACKEND LANDED 2026-06-02
**Latent**: registered + unit-tested, **no pipeline auto-created** and no UI. Backend-only, integration-core (scoped, read-only opt-in). The runner principal-threading (a shared-runtime touch that nothing exercises while latent) is deliberately **deferred to C2**, where a real run happens.

Work items:
- [x] **Host read-only facade** — extracted as its own host module `data-adapters/data-source-plugin-facade.ts` (kernel-free unit-testable), injected as `context.api.dataSources` for **`plugin-integration-core` only** (allowlist), lazily resolving `getDataSourceManager()`. Exposes only `test/getSchema/getTableInfo/select`; **no** create/update/delete/credentials/rotate/connect method.
- [x] **The adapter** `data-source:sql-readonly` (mirrors `metasheet-staging-source-adapter.cjs`): `testConnection/listObjects/getSchema/read`; `upsert` → `NotSupported`. `read` = `parseOffsetCursor(cursor)` → `facade.select` → `{records, nextCursor, done}`. Fail-closed `getDataSourcesApi` guard if the facade is absent.
- [x] **Owner-principal handling**: the adapter **accepts** a principal (factory param) and forwards it to the facade; a missing principal **fails closed** in the facade (no fallback to system/tenant/workspace/admin/service). *(Threading `pipeline.createdBy` from the runner → C2.)*
- [x] **External-system row shape**: `kind='data-source:sql-readonly'`, `role='source'`, `config={ dataSourceId, object?, schema? }`; **no credentials** on the integration row — only the `dataSourceId` reference.
- [x] **Registration** at `index.cjs` adapter registry.

Acceptance locks (covered by `tests/unit/data-source-plugin-facade.test.ts` + `__tests__/data-source-sql-readonly-source-adapter.test.cjs`):
- [x] Contract conformance: `testConnection/listObjects/getSchema/read`; `upsert` throws `NotSupported`.
- [x] **Facade read-only by construction** — negative control: the facade exposes only the 4 read methods; no write/CRUD/credential key.
- [x] **Missing principal fail-closed, NO fallback** (keystone) — undefined/blank principal throws *before the manager is even resolved*; never substitutes a system/tenant/admin identity.
- [x] **Cross-owner read fail-closed** — a mismatched principal → `assertAccess` "not found" propagates; no existence leak.
- [x] **Writable `data_sources` binding rejected** (read-only source only).
- [x] Offset paging at the adapter: full page ⇒ `nextCursor`/not-done; short page ⇒ `done`/null; a facade `select` error **surfaces** (never a silent empty page).
- [x] **No credentials** anywhere (adapter carries only `dataSourceId`; facade exposes none); **no raw `/query`** (only structured `select`); **no K3** surface reachable.
- [ ] **Run uses `pipeline.createdBy`** (not request user, not null) — **moved to C2** (needs a real run).
- [ ] `maxPages` loop fail-closed — **C2** (the pipeline-runner page loop bounds it; the adapter already returns correct `done`/`nextCursor`).

**Post-merge hardening (review of #2192):** two fixes landed after C1 merged — (a) the **writable-source guard moved into the host facade's `authorize()`**, so a writable `data_sources` binding now fails closed on **every** read method (`test/getSchema/getTableInfo/select`), not only when `testConnection()` ran first (the dry-run/pipeline read paths skip it); (b) **adapter metadata** added in `http-routes.cjs` so `/api/integration/adapters` advertises `data-source:sql-readonly` as **`roles:['source']`, no `upsert`, `write:{supported:false}`** instead of the default `source,target,bidirectional`+`upsert`. Both locked by tests (`data-source-plugin-facade.test.ts` writable-every-method · `http-routes.test.cjs` metadata).

### ⬜ C2 — Impl-2: workbench source-system wiring + runner principal-threading
Gated on: C1 + opt-in. Frontend + the one runner seam.
- [ ] **Runner provides the principal**: `createAdapter(sourceSystem, { role:'source', principal: pipeline.createdBy })` (pipeline loaded via `pipelines.cjs:302`); direct external-system test/schema uses the request user. **Lock: a run uses `pipeline.createdBy` (not request user, not null); a NULL-`createdBy` pipeline fails closed with a legible config error.** Also bounds the page loop (`maxPages` fail-closed, no silent truncation).
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
