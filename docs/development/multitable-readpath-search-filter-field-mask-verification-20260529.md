# Multitable read-path search/filter/sort field mask (priority-#2 (a)) — impl & verification

- **Slice**: priority-#2 **(a)** — impl of design-lock #2038 (`docs/development/multitable-readpath-search-filter-field-mask-design-20260529.md`).
- **Status**: implemented + real-DB verified (fail-first). Backend-only; awaiting merge greenlight.
- **Date**: 2026-05-29
- **Grounding**: worktree off `origin/main bf0eefc78`. Lock posture: multitable read-path **kernel-polish** — RBAC/auth, central permission model, `plugin-integration-core`, `src/formula/engine.ts` **NOT touched** ([[k3-poc-stage1-lock]]).

## 1. What changed

The field-read gate (layer-3 `field_permissions.visible`) already gated returned **data** (#2015/#2028) and aggregate **output** (#1840), but search/filter/sort field **selection** still keyed off the static layer-2 set. Now selection is gated by a **layer-3-only** allowed set on both endpoints (`packages/core-backend/src/routes/univer-meta.ts`):

**`GET /view`** (reuses #2015's `allowedFieldIds`, layer-3-only):
- `searchableFields`/`searchableFieldIds` derived `allowedFieldIds.has(id) && isSearchableFieldType` → covers the **SQL fast-path** (`buildRecordSearchPredicateSql`).
- in-memory search path (`recordMatchesSearch`) now passed `searchableFields` (was `visiblePropertyFields`) — **both** `/view` search paths gated.
- `sortRules` and `filteredConditions` add `&& allowedFieldIds.has(...)` — gated at the derivation, so the in-memory **applied** filter (which reads `filterInfo.conditions` = the gated `filteredConditions`) drops a denied condition. (Verified: the gated `filterInfo` is **apply-only** — it is not echoed as content; the returned `meta.computedFilterSort` is a **boolean** flag, and `ignoredSortFieldIds`/`ignoredFilterFieldIds` carry only **non-existent** field IDs — a denied field appears in none of them. The sole filter-**literal** echo is the raw `view: viewConfig`, which is channel **(b)**, deferred. So §4.3's "drop from the echo" reduces, accurately, to "the raw-config literal echo is (b)'s job"; this slice leaves no gated-content echo carrying a denied condition.)

**`GET …/view-aggregate`** — derives its **own layer-3-only** set (`selectableFieldIds`/`selectableFields` = `deriveFieldPermissions(visibleFields, caps, { hiddenFieldIds: [], fieldScopeMap })`), gating search + filter. The existing `aggregateFieldTypeById` (layer-1∧layer-3, `hiddenFieldIds: viewHiddenFieldIds`) is **kept for output omission only** — **not** reused for selection (reusing it would drop readable-but-view-hidden fields on aggregate only → break parity; the locked-design review catch). `fieldScopeMap` is loaded once (moved above the computed-filter check) and reused. The `:5926-5929` comment is revised.

**Denied = non-existent (silent).** A denied search/sort/filter field is dropped exactly like a non-existent one — **not** surfaced in the `ignoredSortFieldIds`/`ignoredFilterFieldIds` "field doesn't exist" warning (would mislead + signal existence). **Computed-filter 422 (view-aggregate):** gated by `selectableFieldIds` too, so a *denied* condition is dropped (= non-existent, no 422), matching `/view`; a *visible* computed-field filter still 422s (approach **B**, per review — keeps denied==non-existent and preserves parity).

## 2. Fail-first proof (real DB)

`tests/integration/multitable-readpath-search-filter-field-mask.test.ts`, `vitest.integration.config.ts`, local real DB.

**Pre-fix (unmodified `bf0eefc78`):** `Tests 6 failed | 4 passed (10)` — each RED is the specific leak:
```
× R1 /view search SQL fast-path     → REC4 matched via FLD_SECRET=canary
× R2 /view search in-memory path     → REC4 matched (the 2nd search path)
× R3 /view saved filter on denied    → narrowed to [REC1] (denied condition applied)
× R4 /view saved sort on denied      → REC4 first (ordered by the denied field)
× R5 view-aggregate search           → total 3 (denied REC3 matched), expected 2
× R6 view-aggregate denied filter    → total 1 (denied filter applied), expected 2
✓ sentinel, R7 (parity), R8 (non-over-restriction + ungranted user), R9 (layer-1 ≠ selection gate)
```
**Post-fix:** `Tests 10 passed`. The exact six leak assertions flip to green; the controls stay green.

R5/R6 assert a **non-zero** `data.total` (2), defeating the empty==empty vacuous pass. The search canary is **unique to `FLD_SECRET`** with a visible-field positive control (search still works, R1/R8). R9 pins **layer-1 ≠ selection gate** (a readable-but-view-hidden field stays searchable on both endpoints, counts agree) — it goes RED if the aggregate selection were gated by the layer-1∧layer-3 output set.

## 3. Regression — clean
- **tsc** (`tsc --noEmit -p tsconfig.json`): no errors in `univer-meta.ts` / the new test.
- **`multitable-view-aggregate.test.ts`** (the most-touched endpoint): **passes**.
- **`multitable-records-read-field-mask.test.ts`** (#2015) + **`multitable-formula-dryrun.test.ts`** (#5c-a): pass. (4 files green together.)
- `d3d1`/`d3d2` golden suites skip-or-fail **locally only** on pre-existing local-DB-schema gaps (the `member-group` `subject_type` CHECK + missing `modified_by` column — proven in #2015); green in CI's freshly-migrated DB.
- **CI wiring**: the new file is added to the `plugin-tests.yml` real-DB step.

## 4. Scope adherence & deferred
**In scope (done):** `/view` (search + filter + sort) + `/view-aggregate` (search + filter) selection gated to layer-3-only; combined per the parity invariant.

**Deferred (each separate opt-in):**
- **(b)** raw `view: viewConfig.filterInfo` **literal** redaction (the literal-in-payload channel; `MetaFilterCondition.value` is still echoed verbatim) — separate design, next.
- **full field-def strip (ii)** — gated on a missing-field-def compat scan.
- **Other layer-2-only read sites** (`POST /patch` echo, form paths, records list, records-summary).
- **Denied + computed filter edge**: a denied condition that *happens to be* a computed field is dropped (not 422), same as `/view` — behavior documented, no separate fixture seeded (proportionate, per review).

## 5. Gated TODO
- ✅ Impl (`/view` 2 search paths + filter/sort selection; `/view-aggregate` own layer-3-only set + computed-check gating; revised comment).
- ✅ R1–R9 real-DB, fail-first (R1–R6 red → all green); wired into `plugin-tests.yml`.
- ✅ Golden-doc note (selection now layer-3-gated; not a model change).
- 🔒 **(b)** literal-redaction design — next separate opt-in.
- 🔒 full-strip (ii) · other read sites — separate, not started.
