# Multitable view-config re-save guard — impl & verification

- **Slice**: impl of the #2068 design-lock (`multitable-viewconfig-resave-guard-design-20260529.md`); follow-up to priority-#2 (b) (#2052 design / #2059 impl).
- **Status**: implemented + real-DB verified (fail-first). Backend-only; awaiting merge greenlight.
- **Grounding**: worktree off `origin/main 0f8fd882c`. Lock posture: multitable write-path **kernel-polish** — RBAC/auth, central permission model, `plugin-integration-core`, `src/formula/engine.ts` **NOT touched** ([[k3-poc-stage1-lock]]).

## 1. What changed

#2059 redacts saved-view filter literals on read (omits `filterInfo.conditions[].value` for fields the requester can't read). Write-path edge: a field-denied `canManageViews` user re-saving a view echoes the redacted condition back **without a `value`** → `PATCH /views/:viewId` overwrote `meta_views.filter_info` and **silently erased** the literal. This guard preserves it.

- **`mergeRedactedFilterInfoForUpdate(incoming, current, allowedFieldIds)`** (`univer-meta.ts`, after the #2059 redactor) — **PURE**; returns the merged `filterInfo` or **`null`** on structural mismatch (route → 400). Rules (per design §3): allowed field → trust incoming; denied + explicit `value` key → trust incoming (existing `canManageViews` write behavior, **not** a new policy); denied + **no** `value` key → match the **same-index** current condition by `(fieldId, operator)` and **restore the current literal** (or keep as-is if current is also unary; **reject `null`** if no safe match). Iterates incoming only → a removed condition stays removed. Value-only: `operator`/`fieldId`/`sortInfo`/`groupInfo`/`config` pass through untouched.
- **`PATCH /views/:viewId` wiring**: `allowedFieldIds` (the #2059 `loadAllowedFieldIds`) is computed **up front**; when `filterInfo` is present, `nextFilter` runs through the merge helper; `null` → `400 VALIDATION_ERROR` (DB untouched). The existing `metaViewConfigCache.set(viewId, view)` already caches the **unredacted** `view` (built from `nextFilter` = the merged filter), and the response returns `redactViewConfigFilterLiterals(view, allowedFieldIds)` — so the #2059 cache invariant (cache unredacted, redact per-response) holds for free (R8).

## 2. Fail-first proof (real DB)

`tests/integration/multitable-viewconfig-resave-guard.test.ts`, wired into `plugin-tests.yml`. Assertions read `meta_views.filter_info` **directly** (the response is redacted either way).

**Pre-fix (unmodified `0f8fd882c`):** `Tests 5 failed | 5 passed (10)`:
```
× R1 redacted denied condition re-save → DB literal ERASED (the mandated corruption proof)
× R2 (the denied literal is also erased while a visible field updates)
× R5 structural mismatch → no guard → 200 (expected 400) + literal erased
× R6 property.hidden (layer-2) literal ERASED (mandated corruption proof)
× R8 allowed reader can't see the (erased) literal afterward
✓ sentinel, R3 (explicit write), R4 (remove), R7 (layer-1 normal write), R9 (unary)
```
**Post-fix:** `Tests 10 passed`. R1/R6 (the §5 mandated fail-first) flip from erased → preserved.

Matrix: **R1** preserve on no-op edit · **R2** allowed field still updates (denied still preserved) · **R3** explicit denied value written, response redacts (scope boundary — not a new write policy) · **R4** removed-stays-removed · **R5** structural mismatch → 400, DB unchanged · **R6** layer-2 `property.hidden` preserved · **R7** layer-1 view-hidden writes normally (readable) · **R8** cross-user: allowed reader sees the preserved literal while the denied writer's response omitted it (cache unredacted + per-response redaction) · **R9** unary denied (`isNotEmpty`) re-saves without rejection or a manufactured value.

> Note (matches design §3/§6): removing a denied condition that **precedes** a still-redacted one shifts indices → the same-index match fails → **400** (intentional; R4 therefore prunes to the allowed condition rather than removing one mid-list). Reorder/structural change of a redacted condition → 400 is the data-safety backstop, not a regression.

## 3. Regression — clean
- **tsc** clean on the touched file.
- **#2059 `multitable-viewconfig-filter-literal-redaction`** (exercises `PATCH /views/:viewId` at its R9) + read-path siblings (#2044 search/filter/sort, #2028 records-read-mask, view-aggregate) + the new test: **5 files green together**.
- `d3d1`/`d3d2` skip-or-fail locally only on the known pre-existing schema gaps; green in CI's fresh DB.

## 4. Scope & non-goals (per design)
In scope: `PATCH /views/:viewId`, `filterInfo.conditions[].value` only, preserve-on-redacted-echo. Out of scope (unchanged): `POST /views` (no prior literal); whether a field-denied `canManageViews` user may *author* a denied-field literal (explicit `value` still follows existing semantics); frontend redacted-input UX; full field-def strip; other layer-2 read sites; RBAC/auth.

## 5. Gated TODO
- ✅ Pure merge helper + `PATCH /views/:viewId` wiring (cache stays unredacted).
- ✅ R1–R9 real-DB, fail-first on R1/R6; wired into `plugin-tests.yml`; tsc clean; regression clean.
- 🔒 Frontend UX (disabled redacted inputs / "value hidden by permissions" badge / stable condition IDs to relax the reorder-400) — separate later opt-in.
