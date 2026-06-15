# Data Factory — read-only SQL data-source bridge — C3 incremental / watermark read — design (2026-06-03)

> **Design-first. No runtime in this slice.** Lifts the C0 **Seam-3 deferral** ("incremental + watermark
> are deferred until a watermark-column convention exists") for the `data-source:sql-readonly` bridge:
> teach the bridge's `read()` to **honor the watermark argument the pipeline-runner already passes**, as a
> parameterized **keyset** `WHERE … ORDER BY … LIMIT` over the existing read-only facade. Equality
> `filters`/`where` support has since landed and must be preserved; the facade `orderBy` seam has
> landed (C3-1, #2609). **Watermark runtime stays 🔒**
> — gated on (a) a real volume / slow-full-reread signal, (b) this convention, and (c) a separate opt-in.
> Read-only; **no read-contract change**; does **not** touch the K3 channel, central RBAC, or auth.

## Why — lift C0 Seam-3, don't rebuild what exists

C0 shipped the bridge with read v1 = **full / manual offset paging** and explicitly deferred incremental
reads. Two things have since become clear from reading `origin/main`:

1. **The runner already speaks watermark.** `pipeline-runner.cjs` already has a pipeline `mode`
   (`manual` | `incremental`), `resolveWatermarkConfig(pipeline)`, an injected `watermarkStore`
   (`getWatermark` / `setWatermark` / `advanceWatermark`), and `deriveNextWatermark(records, config)`
   (`watermark.cjs`, types `updated_at` | `monotonic_id`). In `incremental` mode it already **passes
   `watermark: { [field]: value }` into `sourceAdapter.read(...)`** and advances the store after a clean run.
2. **The DB layer already supports keyset reads.** `BaseAdapter.QueryOptions` already carries
   `where` and `orderBy` (`BaseAdapter.ts:56`), and `DataSourceManager.select` passes them straight to the
   adapter. So `WHERE wm > :last ORDER BY wm ASC LIMIT n` is already expressible underneath.

The remaining reason the bridge is full/manual today is that **its `read()` ignores `request.watermark`**
(does pure offset). Earlier C2-0 hardening already taught the bridge to honor equality `filters` through
structured `where`, and C3-1 widened the read-only facade to pass `orderBy`; the remaining C3 runtime work
closes the watermark/keyset half without regressing that filter path.

This is **design-ahead**. The prior decision stands — full-table offset paging works, and C3 impl is built
only on a **real** large-source / full-reread-too-slow signal. This document is the convention so that, when
that signal appears, the impl is a small, pre-reviewed slice and not a scramble.

## Scope boundary (the load-bearing sentence)

C3 adds **one** capability: the bridge's `read()` **honors the runner's `watermark` argument** as a
parameterized **keyset** read, by **widening the read-only facade `select` to accept `orderBy`** and by
composing the already-supported equality `filters` / `where` with the watermark predicate.

It does **NOT**: change the read contract (the `watermark` / `filters` / `cursor` slots already exist in
`normalizeReadRequest`); build or alter the watermark store (it exists); add a write path (`upsert` stays
`NotSupported`); allow raw-SQL authoring (facade stays parameterized-only); copy or surface credentials;
touch or depend on the K3 SQL Server channel (`k3-wise-sqlserver-*` — red line); merge the `/data-sources`
and workbench UIs; or add cross-owner grants. Owner-scope and read-only stay exactly as locked in C0/C1.

## Grounded current state (verified on `origin/main`)

| Piece | Already exists | The gap C3 fills |
|---|---|---|
| Read contract | `read({object,limit,cursor,filters,watermark}) → {records,nextCursor,done}` — `watermark` + `filters` slots present (`normalizeReadRequest`, `contracts.cjs:91`); `nextCursor` is a string (`createReadResult:126`) | bridge `read()` still uses offset paging and **ignores `watermark`**; equality `filters` are already honored through structured `where` |
| Runner | `mode`, `resolveWatermarkConfig`, `watermarkStore` (get/set/advance), `deriveNextWatermark` (`watermark.cjs`); passes `watermark:{field:value}` into `read()` and advances after success (`pipeline-runner.cjs`) | runner passes **only `{field:value}`**, not the `type` / tiebreaker the keyset needs (see Seam D) |
| DB layer | `BaseAdapter.QueryOptions` has `where` + `orderBy` (`BaseAdapter.ts:56`); `DataSourceManager.select` passes them through (`:530`) | C3-1 widened the **read-only facade** to pass `orderBy`; remaining runtime work must consume it from the bridge adapter |
| Precedent (do **not** depend on) | `k3-wise-sqlserver-executor.cjs:234` already builds `WHERE wm > v ORDER BY orderBy` (strict `>`, single `orderBy=keyField`, one bounded page per run, `done:true`) | K3 is the **red-line** channel; its strict-`>` is safe only because its `keyField` is **unique/monotonic**. The bridge must **generalize it safely** for the non-unique `updated_at` default — not copy it, not import it |

## The design — five seams

### Seam A — widen the read-only facade `select` (the one new host power, done in C3-1)

Extend the facade `select` options from `{ limit, offset, where }` to `{ limit, offset, where, orderBy }`
and pass them through to `DataSourceManager.select` (which already accepts `QueryOptions.where` /
`orderBy`). This host-side seam landed in C3-1 (#2609); `where` pass-through remains present and must be
preserved by the remaining runtime slices.

It stays within the read-only / no-injection seam:
- **Parameterized only** — `where`/`orderBy` are structured (`{ column, op, value }` / `{ column, direction }`),
  built by the adapter from the watermark config and **column names sourced from the introspected schema**
  (`getTableInfo`). **No raw SQL** crosses the facade.
- **No new capability** — it exposes read **query-shaping**, not writes. `manager.select` is still read-only;
  `assertWritable` still guards every mutation route; a **writable `data_sources` binding is still rejected**
  by the facade's `authorize()`.

### Seam B — bridge `read()` honors `watermark` as a **type-conditional keyset** (the heart)

When `request.watermark` carries a value for the configured field, the bridge reads incrementally. The tie
semantics are **type-conditional** — this is the load-bearing correctness decision:

| Watermark type | Uniqueness | Predicate | Order | In-run cursor encodes |
|---|---|---|---|---|
| `monotonic_id` | **unique** | strict `field > lastValue` | `ORDER BY field ASC` | `lastValue` |
| `updated_at` (default) | **non-unique** (bulk updates share a timestamp) | **composite keyset** `field > lastTs OR (field = lastTs AND tiebreaker > lastId)` | `ORDER BY field ASC, tiebreaker ASC` | `(lastTs, lastId)` |

Why the split is not optional:

- **Strict `>` on a non-unique column silently MISSES rows.** Rows sharing one `updated_at` value that
  straddle a page (or run) boundary are skipped and never re-read — an unrecoverable correctness bug.
- **`>=` on a non-unique column can STALL.** If the rows sharing a single timestamp exceed the page `limit`,
  every page re-returns the same first chunk, `nextCursor` never advances → infinite loop. Idempotency does
  **not** fix a stall (it only dedups duplicates).
- The **composite keyset** `(field, tiebreaker)` is the only shape that guarantees **both** no-miss **and**
  forward progress on a non-unique watermark. `monotonic_id` already has a unique key, so it needs no
  tiebreaker and uses the simpler strict `>`.

This maps directly onto the existing `VALID_TYPES = { updated_at, monotonic_id }` split in `watermark.cjs`.

**Mode coexistence:** with **no** watermark value (manual/full mode, or first run with an empty store), the
bridge keeps **today's C1 offset/full path unchanged** — C3 is purely additive.

### Seam C — cursor model + across-run resume (no store change)

- **Within a run**, the bridge drives paging with an **opaque, versioned cursor string** that is **tagged**
  with its mode (`offset` | `wm-mono` | `wm-composite`) and carries the keyset position. A cursor minted in
  one mode is rejected fail-closed if the run's mode disagrees (no offset/keyset confusion).
- **Across runs**, resume uses the **existing single-`{type, value}` `watermarkStore`** (the runner reads
  `currentWatermark.value` and writes `{ type, value }` — a single value, **not** a tuple). So the composite
  tiebreaker **cannot** live in the store. Resolution:
  - **First page of a run** (`cursor = null`) seeds from the store floor: `monotonic_id` → `> storedValue`;
    `updated_at` → `>= storedValue` **with first-page dedup** of rows already emitted at exactly `storedValue`
    (a bounded re-read of one timestamp's rows — at-least-once, absorbed by the existing
    `idempotencyKeyFields` dedup).
  - **Subsequent pages** use the **in-run composite cursor**, which **overrides** the constant store floor.
- The **in-run composite cursor is independent of `deriveNextWatermark`**, which still computes the **single**
  across-run value (the page max) the runner persists. No `watermarkStore` schema change; no runner store change.

### Seam D — how the adapter learns `type` + `tiebreaker` (the one plumbing decision)

The runner passes `watermark: { [field]: value }` — the field **name** and value, but **not** the `type` or
the `updated_at` **tiebreaker** the keyset needs. Two options:

- **(D-recommended) Extend the runner's `read()` payload** to also pass the **resolved `watermarkConfig`**
  (`{ type, field, tiebreaker? }` from `resolveWatermarkConfig`). One additive field on the existing
  `read({...})` call; other adapters (staging/k3/http) ignore it. **Single source of truth** stays
  `pipeline.options.watermark`, and the convention extends it to `{ type, field, tiebreaker? }`.
- (D-alt) The bridge **source config** separately declares `{ watermark: { field, type, tiebreaker } }`.
  Rejected as the default — it risks divergence from `pipeline.options.watermark` (the value the store
  advances), the classic two-sources-of-truth trap.

C3 adopts **D-recommended**: extend `pipeline.options.watermark` to `{ type, field, tiebreaker? }` and pass
the resolved config into `read()`. `updated_at` **requires** a declared `tiebreaker` (a unique column);
absent one, bind-time validation fails closed (Seam E).

### Seam E — preserve `filters` in the same `where` (do not regress C2-0)

The runner **already passes `filters`** into `read()`, and the bridge now normalizes primitive equality
filters into structured `where` before calling the host facade. C3 must preserve that path and AND it with
the watermark predicate in the same parameterized `where`. This prevents a regression back to the old
silent-drop behavior while keeping filters as exact equality predicates only. (The alternative — treating
watermark as a separate mode that bypasses filters — is rejected: silently dropping an actively-sent
argument is the same wire-vs-fixture class of bug.)

## Correctness principles (stated, each a negative control at impl time)

- **Monotonicity is a precondition.** The watermark column must be non-decreasing for "changed since"
  semantics to be sound; a row written with a watermark ≤ the stored value is missed. The convention states
  this; bind-time validation can only check orderability/type, not the source's write discipline.
- **Tie handling is type-conditional** (Seam B) — strict `>` for `monotonic_id`, composite keyset for
  `updated_at`. Negative controls: a same-timestamp batch spanning a page boundary loses **no** row
  (no-miss), and a same-timestamp batch larger than `limit` still **advances** (no stall).
- **Timestamp clock-skew / late arrival is a known limit.** A wall-clock `updated_at` row that commits with
  an earlier timestamp **after** the watermark advanced is missed. `monotonic_id` avoids it; a bounded
  **overlap / lag-window** re-read for `updated_at` is a **deferred** sub-option, not v1.
- **Index or it's a full scan.** `WHERE wm > … ORDER BY wm` without an index on the watermark (and
  tiebreaker) column is a full table scan — defeating the entire perf purpose. Bind-time validation
  **recommends/requires** the index; impl notes it loudly.
- **Determinism improves, not regresses.** C0 Seam-3 flagged offset paging as correct only under a stable
  order; keyset paging on `(field[, tiebreaker])` is **strictly more stable** than offset — this is a net
  improvement over the current full/manual path.

## Guardrails / invariants (unchanged from C0/C1 — re-asserted)

- **Read-only by construction** — Seam A widens query-**shaping**, not writes; the facade still exposes no
  create/update/delete/credentials method; `upsert` still throws `NotSupported`; a **writable** binding is
  still rejected.
- **Owner-scope fail-closed** — every incremental read still authorizes via `assertAccess` with the real
  principal (`pipeline.createdBy`); missing principal still fails closed, no system/admin fallback.
- **No credential copy** — the integration row still carries only `dataSourceId`; `filters`/`watermark`
  values and any error text pass the shared redaction self-check (a watermark value is data, not a secret,
  but the redaction self-check must still pass).
- **No raw SQL** — only structured `where`/`orderBy` built from introspected column names.
- **No K3** — generic source only; the K3 channel is neither touched nor imported (it is cited only as a
  precedent we deliberately **do not** copy).
- **Bind-time fail-closed** — `mode=incremental` with **no resolvable watermark field**, an
  **un-introspectable / non-orderable** column, or `updated_at` with **no tiebreaker** → a clean
  configuration error, **never a silent full-table scan**.

## Phased decomposition (gated — each a separate explicit opt-in)

- ✅ **C3 design** (this document).
- ✅ **C3-1 — facade widen (host):** `select` options `+ orderBy` while preserving the already-landed
  `where` pass-through to `DataSourceManager.select`; parameterized-only; writable-source still rejected.
  Facade unit test covers pass-through, malformed `orderBy` fail-closed, uppercase direction normalization,
  and the existing no-fallback / writable-source guard. Landed in #2609 / squash `1586c3841`.
- ✅ **C3-2a — structured `where` logical groups:** widen adapter structured reads to express the
  `updated_at` composite keyset predicate as `field > last OR (field = last AND tiebreaker > lastTie)`;
  keep all values parameterized; reject malformed logical groups and unknown `$` operators fail-closed;
  add MySQL operator parity with Postgres/MSSQL. This is a prerequisite only — no watermark predicate is
  generated yet, and the offset/full path stays unchanged. Landed in #2625 / squash `c2c59994c`.
- 🔒 **C3-2 — adapter watermark mode (plugin):** type-conditional keyset (Seam B) + cursor model (Seam C).
  Current implementation slice wires `data-source:sql-readonly.read()` so `watermark + watermarkConfig`
  generates structured `where/orderBy`, with `updated_at` first-page `>=` store-floor seeding and
  subsequent in-run `(field,tiebreaker)` composite cursors, plus `monotonic_id` strict `>`.
  SQL BIGINT monotonic values are preserved as integer strings, not coerced through JS `Number`.
  Offset/full coexistence and wrong-mode cursor fail-closed behavior are unit-locked. Runtime run details
  redact watermark cursors (they contain source values), and max-page truncation is partial/no-watermark-advance
  rather than a silent succeeded run. C3-5 remains the real-DB acceptance gate.
- ✅ **C3-3a — watermark-config plumbing (runner → read request):** extend `pipeline.options.watermark` to
  `{ type, field, tiebreaker? }`, pass the resolved config into `read()` (Seam D), and require
  `updated_at` configs to declare a tiebreaker for the `data-source:sql-readonly` bridge. Landed in #2619
  / squash `7f61709ea`; the remaining column exists/orderable/indexed validation stays gated with the
  runtime slices.
- ✅ **C2-0 — honor equality `filters`:** parameterized equality `filters` already pass through as `where`
  before C3 runtime.
- 🔒 **C3-4 — filter + watermark composition lock:** keep those equality filters AND'd with the watermark
  predicate; negative control: a filter value cannot inject SQL and cannot be dropped when watermark mode is
  active.
- 🔒 **C3-5 — real-DB locking test (the keystone, wire-vs-fixture):** against a **real** Postgres (and the
  MSSQL smoke), an incremental run reads **only** rows beyond the stored watermark; same-timestamp
  boundary/stall cases hold; a no-watermark run still does the full re-read; cross-owner is still fail-closed.
  Per the entity-machine lesson (#2205), the committed fake-facade unit tests do **not** prove the
  facade→`DataSourceManager`→real-adapter→DB keyset path — this real-DB test is the acceptance keystone.

**All remaining C3-2..C3-5 work stays 🔒** until both a real volume/perf signal **and** a separate opt-in.
Build order from the current mainline: C3-2 (adapter mode + cursor)
→ C3-4 (filter+watermark composition) → C3-5 (real-DB lock).

## Acceptance checklist (the locks — for the impl slices)

- ⬜ `monotonic_id`: strict `>`, single-key order, progress guaranteed.
- ⬜ `updated_at`: composite keyset `(field, tiebreaker)` — **no-miss** across a same-timestamp page boundary.
- ⬜ `updated_at`: a same-timestamp batch larger than `limit` **still advances** (no stall).
- ⬜ Watermark cursors remain internal: raw cursor values are not persisted in run details / evidence.
- ⬜ Source page-cap truncation (`maxPagesReached`) is partial and blocks watermark advance.
- ⬜ Across-run resume: first page seeds from the store floor (`>` mono / `>=`+dedup `updated_at`); subsequent
  pages use the in-run composite cursor; no `watermarkStore` schema change.
- ⬜ Mode coexistence: no watermark ⇒ the C1 offset/full path is byte-for-byte unchanged.
- ⬜ Cursor mode-tagging: a cursor minted in one mode is **rejected fail-closed** under a different mode.
- ⬜ `filters` honored as parameterized equality predicates; **no raw SQL / no injection**.
- ✅ Facade widen exposes **no** write/CRUD/credential method; writable binding still rejected (#2609).
- ⬜ Owner-scope **fail-closed** preserved on the incremental path (`assertAccess` via `pipeline.createdBy`).
- ⬜ Bind-time **fail-closed**: incremental with no resolvable watermark field / non-orderable column /
  `updated_at` without a tiebreaker ⇒ clean config error, never a silent full scan.
- ⬜ **Real-DB locking test** green (the keystone) — not just fake-facade units.

## Decision log / deferred

- **Design-ahead, impl 🔒.** The prior "offset works, C3 not needed yet" decision stands; impl is built only
  on a real volume/perf signal + a separate opt-in. This doc removes the design risk, not the gate.
- **K3 precedent cited, never depended on.** `k3-wise-sqlserver-executor` is the red-line channel; C3
  generalizes its watermark→`where` pattern safely for non-unique watermarks **without** touching or
  importing it.
- **Deferred sub-options:** the `updated_at` clock-skew **overlap/lag-window** re-read; composite/multi-column
  watermarks beyond `(timestamp, id)`; backfill / watermark-reset semantics; surfacing the watermark
  field/tiebreaker in the workbench UI (config-only in C3 — a later UI slice).

## Gating posture

New integration-core read-only surface → post-GATE **scoped, read-only opt-in** (named, **not** auto-start).
No K3 surface, no RBAC/auth touch, no write ⇒ low-risk scoped gate. Each C3-N slice above is its own explicit
opt-in; **none starts** until both a real incremental-read need (volume/perf signal) and that opt-in. This
track stays **parallel to the K3 line** and blocks nothing on it.
