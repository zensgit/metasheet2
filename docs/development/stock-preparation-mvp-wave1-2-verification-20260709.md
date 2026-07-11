# Stock-Preparation MVP (#3751) — Wave 1 + 2 Design & Verification

Date: 2026-07-09. Scope: the runtime + frontend slices that take the stock-preparation MVP from
"validated table templates with zero runtime consumer" to "provisionable internal tables + readonly
sync-plan + first operator view", plus the gated first-persistence slice held for owner review.

Authoritative spec: [`stock-preparation-mvp-design-20260707.md`](./stock-preparation-mvp-design-20260707.md).
This document records what shipped and how each slice was verified.

## Safety envelope (enforced on every slice, mutation-tested)

- **No external write.** All generate/write is MetaSheet-INTERNAL table operations only. No ERP/K3/PLM
  write, no `stock-preparation-apply-writer` (the #2253 external lane), no `stockPrepApplyProduction`, no
  K3 Save/Submit/Audit, no auto ERP material creation, no raw SQL. (The C4 external-apply lane remains
  owner-gated and untouched.)
- **Readonly-first.** Reads (PLM BOM expansion, ERP material) are readonly; the sync-run PLAN persists
  nothing; the first persistence slice is isolated and held for owner sign-off.
- **Values-free evidence.** Every slice's evidence carries counts / statuses / field-key NAMES / public
  objectId constants / booleans only — never a raw drawing number, project value, credential, host,
  tenant, or row payload. (Plan/persist ROWS carry the business data by necessity — that is the output —
  but evidence never does; this is pinned by a planted-secret absence test in each suite.)
- **Admin-gated, fail-closed.** Every route calls `requireAccess(req,'admin')` before delegating; every
  module re-asserts the admin permission before any I/O.
- **Grounded to frozen templates.** Table structures, field ids, and enum literals come from the frozen
  MVP templates and the pinned DN_PDM read plan — nothing invented. Open decisions are surfaced to the
  owner, never hardcoded to a customer-specific choice.

## Shipped slices

| Slice | PR | State | Tests | Mutation gate |
|---|---|---|---|---|
| expansion→snapshot-line mapper (+ missing_child_bom stamping) | #3978 | merged | 16 | 4/4 KILLED |
| provision 9 MVP tables (readiness/ensure/option-sync routes) | #3984 | merged | 16 | 4/4 KILLED |
| FE shell (`/stock-prep` route + 6 view containers + nav) | #3979 | merged | 17 | readonly, values-free guard |
| readonly BOM-snapshot sync-run PLAN orchestrator + route | #3986 | merged | 10 | 4/4 KILLED (+1 provably-equivalent) |
| FE view 1 — readonly Project Workspace | #3987 | merged | 21 | readonly, values-free guard |
| **W2-persist** — commit plan rows into 9 internal tables | **#3995** | **OPEN — held for owner** | 8 | **7/7 KILLED** |

### 1. Expansion→snapshot-line mapper (#3978)
Pure/deterministic bridge: `mapExpansionRowsToSnapshotLines` reshapes `expandPlmProjectBom` output
(componentCode/sourceVersion/path/rawQuantity/…) into the snapshot-line shape the diff/generation engines
consume, and stamps the previously-unreachable `missing_child_bom` rowError into an incomplete line so the
diff/exception case becomes reachable end-to-end. No I/O. Mutations killed: designQty ordering
(rawQuantity, not totalQuantity rollup), missing_child_bom stamping, marker propagation, values-free.

### 2. Provision the 9 MVP tables (#3984)
`inspect/ensure/syncOptions` over the frozen `STOCK_PREPARATION_MVP_TABLE_TEMPLATES`, reusing the canonical
provisioning API (structure-only — `rows` always `[]`; `rowsSeeded:0`). Existing-but-incomplete table
fails closed (never repairs a business table in place). Routes: `GET /mvp/readiness`, `POST /mvp/ensure`,
`POST /mvp/options/sync`. Mutations killed: admin gate (all 3 entrypoints), structure-only, values-free,
fail-closed on incomplete. Option vocabularies are admin-supplied at runtime (no hardcoded default set).

### 3. FE shell (#3979)
Routed, tabbed workspace shell gated on `integration:write`; 6 readonly per-view service stubs (GET only,
404-soft until backend lands); snapshot-batch vocabulary chosen to avoid collision. No write path.

### 4. Readonly sync-run PLAN orchestrator (#3986)
`planBomSnapshotSyncRun` composes the landed mapper + diff engines into a values-free plan (snapshot batch
+ lines + sync-run record + diff + surfaced flags), grounded to the frozen batch/line/run templates.
Persists NOTHING; imports only pure engines. Route `POST /mvp/sync/plan`. Mutations killed: admin gate,
immutable-draft status, flags-surfaced (never dropped), values-free evidence. Flags surfaced (not
dropped): missing_child_bom / incomplete / duplicate_path_key / missing_design_qty / missing_design_unit.
`missing_mapping` / `unit_conflict` correctly deferred to Phase 3 (need ERP mapping + unit data).

### 5. FE view 1 — Project Workspace (#3987)
Readonly view rendering the values-free per-project overview (counts/status/internal handles), with
graceful loading / empty / 404-soft states; raw error bodies never rendered. Values-free guard plants
business values and asserts none reach the DOM.

### 6. W2-persist — first business-row write (#3995, HELD)
Commits a previously-previewed plan by recomputing it deterministically and writing batch/line/run rows
into the 9 internal MVP tables. **Internal-only is structural**: every write goes through
`createTargetScopedRecordsApi` bound to a resolved MVP sheet (throws on any cross-sheet call), and each
target objectId is asserted ∈ the frozen 9-table set. Idempotent (existing snapshotBatchId → skip whole
commit) and immutable (`createRecord` only; no patch/overwrite; old snapshots immutable). Route
`POST /mvp/sync/persist`. **7/7 mutations killed** (admin, scoped-only, idempotency, immutability,
line-grounding, values-free, fail-closed-on-unprovisioned).

**Held for owner review** because it is the first slice that writes business rows. It is within the
authorized envelope (internal-table writes are permitted; only external writes are barred), but as the
first irreversible row-write the merge decision is reserved for the owner.

## Open decisions (surfaced, not hardcoded)

1. MVP option-field vocabularies (19 option fields across the 9 tables) are admin-supplied at sync time;
   no canonical default set is shipped. Owner may later decide to ship defaults.
2. `designQty` maps from the plan's per-line `rawQuantity`, not the `totalQuantity` rollup (plan-faithful).
3. sync-run engine defaults: `run.status` = partial-if-any-flag-else-succeeded; `snapshot_version`
   defaults to 1 (incrementing needs the persistence layer's prior-max); `source_system` passthrough only.
4. **W2-persist atomicity limitation (known, non-security):** batch row is written first (idempotency
   key), then lines, then run. A crash after the batch row but before lines/run leaves an orphaned empty
   batch that a retry skips — bounded (visible, no duplicate/corrupt data; re-sync with a new batch id
   works). Proper fix = transactional / two-phase (pending→draft) commit, a P4 hardening item.
5. W2-persist leaves who/when stamps (createdAt/createdBy) unset (deterministic; owner decides).

## What unblocks on the owner's W2-persist merge-go

Readonly read/summary endpoints (light up FE view 1 with real data) → FE views 2–6 → Phase 3 auto-match +
exception queue (material-mapping / unit-conversion manual confirmation) → Phase 4 operational hardening
(including the atomicity fix above).
