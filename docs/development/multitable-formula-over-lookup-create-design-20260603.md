# Multitable Formula-over-Lookup on CREATE / SUBMIT / IMPORT — Design-Lock — 2026-06-03

> Status: **DESIGN-LOCK (docs-only). No code in this PR.** Owner decisions locked 2026-06-03 (§3, §6, §8). Implementation is a **separate cut**.
> Author: Claude (Opus 4.8, 1M context) + read-only recon on `origin/main` @ `4ee21192b` (A-min #2247 present).
> Sibling of A-min (#2246/#2247, the PATCH path). This is the **first same-record computation on insert** —
> NOT A-full (no foreign-record propagation). One page on purpose; it exists to lock the **multi-path boundaries
> + test matrix** before code, because three different insert paths are involved and direct-writing risks missing one.

## 0. Scope in one line

A new/submitted/imported record whose **same-record** `link → lookup/rollup → formula` chain should compute on
insert currently does not (or computes against `0`). Fix the first computation across the three insert paths,
reusing A-min's `recalculateRecordFromData` + the existing `applyLookupRollup`. Same-record / same-sheet only.

## 1. Current-state ground truth (the three paths differ)

| Path | Entry | Insert | Formula recalc today | Gap |
|---|---|---|---|---|
| **PATCH** | `RecordWriteService.patchRecords` | — | ✅ hydrate (Step 4) → `recalculateRecordFromData` (A-min #2247) | none |
| **Create** | `RecordService.createRecord` (`record-service.ts:407`) — used by **POST /records** (`univer-meta.ts:7569`) AND **import-xlsx** (`:5605`) | meta_records `:564` + meta_links `:574` | ❌ **none at all** — no recalc, no hydration | all formulas uncomputed on create (over-lookup included) |
| **Form-submit** | `POST /views/:viewId/submit` (`:6895`), hand-written insert `:7195` | inline | ⚠️ **raw** `recalculateRecord` (`:7280`) — no hydration | formula-over-lookup computes against `0` |

So: **create has no recalc; form-submit recalcs raw**. Both leave same-record formula-over-lookup wrong on the
record's first appearance. (PATCH is already correct via A-min.)

## 2. Mechanism (reuse — no new eval logic, no frozen-core change)

Post-insert (after meta_links are written), for the just-created record(s): load the row → `applyLookupRollup`
(hydrate same-record lookup/rollup in-memory) → `recalculateRecordFromData(query, sheetId, recordId, hydratedData, fields)`
(A-min #2247 — evaluates **all** formula fields against the provided data, writes back **only formula keys**).
On create there is **no dependency-gate** (it is a fresh record → compute all its formulas once); no foreign/related
recompute; lookups are **not materialized**. `src/formula/engine.ts` untouched.

## 3. The layering decision (the boundary to lock)

`applyLookupRollup` is a **route-layer** helper: it needs `req` (perm-scoped foreign-sheet read,
`resolveReadableSheetIds`) and is wired req-bound at `univer-meta.ts:8455`. `RecordService` is service-layer
(`new RecordService(pool, eventBus)` — no helpers). So "hydrate in the service layer" is not free.

**DECIDED 2026-06-03: inject a route-supplied recalc hook into `RecordService`** via a setter, mirroring the existing
`setYjsInvalidator` / `setPostCommitHooks` pattern (and `RecordWriteService`, which already takes an injected
`applyLookupRollup`). The hook = `(query, sheetId, recordIds, fields) => Promise<void>` built at the route layer
(has `req` + `applyLookupRollup` + `recalculateRecordFromData`); `createRecord` invokes it post-insert when set
(and the sheet has a formula field). Then:
- **POST /records** and **import-xlsx** both construct `RecordService` inside route handlers where the req-bound
  hook is available → set it → **inherit automatically** (this is the "service-layer benefit" the owner wants).
- **Form-submit** does not use `RecordService` (hand-written insert) → call the **same** hydrate→`recalculateRecordFromData`
  sequence directly in the handler (replacing the raw `recalculateRecord` at `:7280`).
- Backward-compatible: hook unset → no recalc (current behavior); no regression for callers that don't set it.

Alternative (rejected): a purely route-layer shared helper called explicitly by each handler — cleaner layering
but xlsx would NOT auto-inherit (needs an explicit call), losing the owner's stated benefit.

### 3.1 Locked invariants (owner, 2026-06-03)

1. **`RecordService` never learns `req` / RBAC / `applyLookupRollup`.** It exposes only an optional hook; the route
   layer injects the req-bound helper. `applyLookupRollup` is **not** sunk into the service.
2. **Hook unset = current behavior** — the no-recalc path stays valid for non-route / test construction (no regression).
3. **The hook runs only AFTER insert + meta_links are written** (the links must exist before lookup hydration resolves).
4. **The hook writes back only formula keys; lookup/rollup are NOT materialized** (reuses `recalculateRecordFromData`).
5. **A fresh record does NOT go through the dependency gate** — it computes **all** formula fields once (the gate is a
   PATCH-path optimization; on create everything is new).
6. **Form-submit reuses the SAME hydrate→`recalculateRecordFromData` helper** — it does **not** duplicate eval logic;
   it only differs in that it owns its hand-written insert (so it calls the helper directly rather than via `RecordService`).

## 4. Permission / echo boundary

Hydration reuses the **same** `applyLookupRollup` (perm-scoped foreign read) — no new read path, no field-read-gate
bypass, no new field-permission gate. The created/submitted record **echo** stays behind the existing D1 field-read
mask (`filterRecordDataByFieldIds`) — unchanged. Formula-result-encodes-its-inputs remains the pre-existing
systemic property (per #2246 §4), not widened here.

## 5. Explicitly NOT in scope

Foreign-record → related-record propagation (**A-full / bounded C2a**); correct **multi-value** lookup arithmetic
(**Option D** parser); dry-run hydration; lookup/rollup materialization; storage/migration; central RBAC/auth.

## 6. Test matrix (fail-first, real-DB; added to the plugin-tests.yml runner list)

| # | Path | Scenario | Assert |
|---|---|---|---|
| **C1** | **POST /records create** (required) | create a record with link→foreign + lookup + formula `={lu}+1` | created record's formula = the **actual** lookup value (e.g. `6`), not absent/uncomputed. Fail-first: pre-fix it is uncomputed |
| **C2** | **POST /views/:viewId/submit create** (required) | submit a record on a form view with the same link/lookup/formula | formula = actual value, not `0`. Fail-first: pre-fix raw recalc → `0` |
| **C3** | **import-xlsx** (DECIDED: real-DB smoke) | import a row mapping the link field — **minimal** fixture (smallest constructable, no large xlsx) | the imported record's formula-over-lookup = actual value. Fall back to "documented-inherited + U1" **only** if the minimal fixture proves prohibitively costly |
| **N1** | boundary (same-record only) | C1/C2 records | the create-recalc computes only the **new** record's formula from its own links; it does not touch other records (A-full stays out) |
| **U1** | unit | `createRecord` wiring | `createRecord` calls the injected recalc hook once post-insert when set, and skips when unset (mirrors the A-min `record-write-service` unit guard) |

Numeric semantics inherited from A-min (`recalculateRecordFromData`): single-value numeric lookup → arithmetic
correct (`={lu}+1`=6); bare `={lu}` = value-as-string; multi-value joins to a string (Option D).

## 7. PR slicing

One implementation PR (small): RecordService recalc-hook + wiring at POST /records + xlsx, form-submit
hydrate-before-recalc, tests C1/C2/(C3)/N1/U1. **Separate cut from this design-lock.** A-full / Option D stay gated.

## 8. Decisions (locked 2026-06-03)

1. **Layering → service-hook injection.** `RecordService` exposes an optional recalc hook; the route layer injects
   the req-bound helper. POST /records + import-xlsx inherit automatically; form-submit calls the same helper
   directly. `applyLookupRollup` stays route-layer (not sunk into the service). See §3 + the §3.1 invariants.
2. **xlsx coverage → real-DB smoke (C3)** with a minimal fixture; fall back to documented-inherited + U1 only if
   the fixture cost is prohibitive.

> Implementation is a separate cut; A-full / dry-run / parser / multi-value arithmetic / materialization /
> migration / RBAC-auth all stay out.
