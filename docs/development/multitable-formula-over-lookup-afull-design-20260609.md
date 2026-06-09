# Multitable Formula-over-Lookup A-full — Design-Lock — 2026-06-09

> Status: **DESIGN-LOCK (docs-only). No runtime code in this PR.**
> Builds on `multitable-formula-over-lookup-design-20260603.md` (A-min) and
> `multitable-formula-over-lookup-create-design-20260603.md` (create/submit/import).
> Current recon: `origin/main` @ `db6b128ee`.
> K3 / frozen: multitable kernel-polish only. Do **not** touch
> `packages/core-backend/src/formula/engine.ts`, central RBAC/auth, migrations, or
> `plugin-integration-core`.

## 0. Scope in one line

Support the bounded A-full case: when a **foreign record's target field** changes,
existing linked records whose `lookup`/`rollup` values change should also recompute
their own formula fields that reference those computed fields.

This is **not** a general derived-field graph, not recursive transitive propagation,
not lookup/rollup materialization, and not dry-run hydration. It is one synchronous
write-path slice on top of the existing `POST /api/multitable/patch` related-record
recompute seam.

## 1. Current-state ground truth

### 1.1 What is already shipped

- **A-min PATCH path** is shipped. `recalculateFormulaFields()` expands a same-record
  link edit into the corresponding same-record lookup/rollup field id, then evaluates
  the record's formulas against the full in-memory hydrated row. See
  `univer-meta.ts:1621-1677` and `record-write-service.ts:837-899`.
- **Create / submit / import first computation** is shipped. New records hydrate
  lookup/rollup before `recalculateRecordFromData()`. See `univer-meta.ts:1680-1729`.
- The A-min real-DB test still intentionally locks the A-full gap as a negative:
  editing the foreign record leaves the related record's formula stale
  (`multitable-formula-over-lookup-view.test.ts:T4a`).

### 1.2 The remaining A-full gap

`computeDependentLookupRollupRecords()` already finds records linked to the just-edited
foreign record, loads those related records, hydrates lookup/rollup with
`applyLookupRollup()`, and returns per-related-sheet masked lookup/rollup patches for
the response (`univer-meta.ts:1907-2001`). But it stops there:

- the changed computed field ids are never fed into formula recalc for the related
  records;
- the related record's formula stays stale in `meta_records.data`;
- the response may show a fresh lookup/rollup patch while the formula field still
  reflects the old value.

This is exactly A-min's T4a negative becoming A-full's positive.

## 2. Design decision

**DECIDED for this slice:** implement **bounded synchronous A-full** on the existing
related-recompute seam.

In practice:

1. A foreign-record PATCH carries the source `sheetId`, changed source field ids, and
   updated source record ids into the related-recompute helper.
2. For each related record whose lookup/rollup is affected by that source field change,
   hydrate the related row with the existing `applyLookupRollup()`.
3. Recalculate formulas on that related row using `recalculateRecordFromData()` via the
   existing `recalculateFormulaFields()` gate, with the affected lookup/rollup field ids
   as `changedFieldIds`.
4. Persist **only formula keys**. Lookup/rollup values remain computed-on-read and are
   never materialized.
5. Return the masked lookup/rollup + formula patch in the same related-record response
   channel already used by `computeDependentLookupRollupRecords()`.

This is deliberately one hop:

`foreign source field -> related lookup/rollup -> formula on that related record`

It does **not** recursively continue from the formula result to downstream formulas or
other related records.

## 3. Required implementation shape

### 3.1 Extend the existing route helper, do not create a graph engine

The implementation should extend/rename `computeDependentLookupRollupRecords()` rather
than introduce a new global derived-field graph. That helper already owns the hard parts
this slice needs:

- reverse link lookup via `meta_links.foreign_record_id`;
- related sheet grouping;
- per-related-sheet readability gate (`resolveSheetReadableCapabilities`);
- related sheet field loading;
- `applyLookupRollup()` hydration;
- per-related-sheet `allowedFieldIds` for echo masking.

The new helper may return a richer internal shape, but the public response shape should
stay compatible: `records` for same-sheet related records and `relatedRecords` for
cross-sheet related records.

### 3.2 Full hydrated row for formula eval; masked patch only for echo

This is load-bearing. The current helper returns `data` after
`filterRecordDataByFieldIds(extractLookupRollupData(...), allowedFieldIds)`. That is an
**echo payload**, not a safe formula input.

The implementation must keep two separate views of the same related row:

- **Full hydrated row**: all row data after `applyLookupRollup()`; used only for
  `recalculateRecordFromData()` so production formula recalc stays reader-agnostic,
  matching A-min.
- **Masked echo patch**: lookup/rollup/formula keys filtered through the related sheet's
  `allowedFieldIds`; used only for the HTTP response.

Do not feed a field-permission-filtered echo patch into formula evaluation.

### 3.3 Compute the affected lookup/rollup ids, not every related formula blindly

The helper should treat a related lookup/rollup as affected only when all are true:

- the related field is `lookup` or `rollup`;
- its config resolves to the edited source sheet;
- its `targetFieldId` is one of the source PATCH `changedFieldIds`;
- the related record links to one of the edited source `recordIds`.

Then pass those affected computed field ids into `recalculateFormulaFields()` for that
related sheet. This preserves the existing dependency gate:

`formula_dependencies.depends_on_field_id IN affectedComputedFieldIds`.

Unrelated edits on the foreign record must not rewrite formula fields just because the
record is linked.

### 3.4 Keep the current permission side-effect boundary

This slice reuses the current related-recompute reachability boundary:

- if the request actor cannot read a related sheet, that related sheet is skipped;
- if the request actor cannot resolve a foreign sheet through `applyLookupRollup()`, the
  computed value remains empty/null under current semantics;
- no central RBAC/auth changes and no new field-permission gate.

This is **not** a global background recompute system. A future async derived graph could
make propagation actor-independent; that is outside this slice.

### 3.5 Realtime boundary

This slice materializes the related record's formula value in the database and returns
the masked related patch in the existing response. It does **not** add a new cross-sheet
realtime fan-out protocol.

Current `RecordWriteService` realtime publishes only the edited sheet's updated record
patches (`record-write-service.ts:949-978`). A new per-related-sheet realtime fan-out
would need its own design because recipient field masks are per subscriber. Do not
bundle it here.

## 4. Explicitly not in scope

- Recursive formula propagation beyond the one related record.
- Formula -> formula support. The A2-defense remains: formulas cannot reference other
  formulas.
- Correct multi-value lookup arithmetic / parser changes (Option D).
- Lookup/rollup materialization.
- Dry-run hydration.
- Cross-sheet realtime fan-out.
- Migrations / storage-model changes.
- `packages/core-backend/src/formula/engine.ts`.

## 5. Test matrix

All implementation tests for this slice should be fail-first and wired into the
`plugin-tests.yml` real-DB runner list. The existing A-min file is the right fixture to
extend or mirror because it already carries T1/T2 and T4a.

| # | Scenario | Required assertion |
|---|---|---|
| **AF1** | Edit a foreign record's target field used by a related lookup | the related record's formula is materialized with the new lookup value. This flips A-min T4a from stale to fresh |
| **AF2** | Same as AF1, but inspect the HTTP response | related patch includes the formula field only if the caller can see that formula field; no denied lookup canary appears |
| **AF3** | Edit an unrelated field on the foreign record | related formula does **not** rewrite; affected lookup/rollup ids are target-field-aware |
| **AF4** | Multiple related sheets, one readable and one unreadable to the actor | readable sheet recomputes; unreadable sheet is skipped under the current related-recompute boundary |
| **AF5** | Related formula depends on rollup, not lookup | rollup-backed formula recomputes using the hydrated rollup value |
| **AF6** | A-min regression | same-record link edit still recomputes exactly as before |
| **AF7** | Create/submit/import regression | first-computation paths stay green; no new dependency gate on create |
| **AF8** | Static boundary | no diff to `src/formula/engine.ts`, no migration, no central RBAC/auth |

Recommended concrete fail-first seed:

- Sheet F: numeric target field `target`.
- Sheet M: `link -> F`, `lookup(target)`, `formula = {lookup}+1`.
- Seed M's formula as stale (`10`).
- PATCH F.target from `9` to `100`.
- Pre-fix: M.formula remains `10`.
- Post-fix: M.formula becomes `101`.

## 6. Rollback

Storage-neutral. Reverting the implementation returns to A-min behavior: same-record
formula-over-lookup remains fixed, while foreign-record propagation becomes stale again.
Formula values materialized during the enabled window remain until the next recalc,
which is the same derived-value rollback posture as A-min.

## 7. Implementation PR boundary

One implementation PR is acceptable after this design-lock is merged:

- update the route helper and `RecordWriteService` wiring;
- add real-DB AF tests to the plugin runner;
- keep all runtime changes under `packages/core-backend/src/routes/univer-meta.ts`,
  `packages/core-backend/src/multitable/record-write-service.ts`, and tests unless a
  type-only helper extraction is justified.

Do not include dry-run, parser, realtime fan-out, storage, or frontend work in that PR.
