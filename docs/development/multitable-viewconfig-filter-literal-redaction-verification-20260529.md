# View-config filter-literal redaction (priority-#2 (b)) — impl & verification

- **Slice**: priority-#2 **(b)** — impl of design-lock #2052 (`docs/development/multitable-viewconfig-filter-literal-redaction-design-20260529.md`).
- **Status**: implemented + real-DB verified (fail-first). Backend-only; awaiting merge greenlight.
- **Date**: 2026-05-29
- **Grounding**: worktree off `origin/main a3ba6afde`. Lock posture: multitable read-path **kernel-polish** — RBAC/auth, central permission model, `plugin-integration-core`, `src/formula/engine.ts` **NOT touched** ([[k3-poc-stage1-lock]]).

## 1. What changed

A saved view's `filterInfo.conditions[].value` (the comparison **literal**) was echoed verbatim wherever a view config is serialized — leaking a field-denied user that field's filter literal. Now a shared **pure, field-permission-aware** helper redacts it.

- **`redactViewConfigFilterLiterals(view, allowedFieldIds)`** (`univer-meta.ts`): **PURE** — returns a redacted **copy** (view configs are cached/shared via `invalidateViewConfigCache`; in-place mutation would corrupt a later cross-user read). For each `filterInfo` condition whose `fieldId ∉ allowedFieldIds`, **omits the `value` key** (keeps `fieldId`+`operator` so the client still renders the chip — compat-scan-confirmed safe, §3). `sortInfo`/`groupInfo`/`config`/`hiddenFieldIds` carry only fieldIds → untouched. Returns the input unchanged (never mutated) when nothing needs redacting.
- **`computeAllowedFieldIds` / `loadAllowedFieldIds`**: the layer-2 ∧ layer-3 composite (`deriveFieldPermissions(visible, caps, { hiddenFieldIds: [], fieldScopeMap })` — #2015 primitive). `loadAllowedFieldIds` returns **EMPTY for no-subject/no-sheet ⇒ fail closed**.

**Applied at every view-config echo (7 real sites):** `GET /context` (3599), `GET /views` (5066), `GET /view` (6514), `GET /records/:recordId` (7498), `POST /views` (5155), `PATCH /views/:viewId` (5260), and `GET /form-context` (6648, **empty set ⇒ all literals redacted, fail-closed**). `/view`+`/records` reuse their existing `allowedFieldIds` (#2015/#2028); `/views`/create/update compute it per requester; `/context` computes it **off `effectiveSheetId`** (see below).

**`/context` fail-open fix (the base-only vector):** `/context` built `fieldScopeMap` off `resolvedSheetId`, which is **null on `?baseId=`** while the returned views bind to the inferred `effectiveSheetId` → empty map → fail open. Now `fieldScopeMap` + the redaction's `allowedFieldIds` both bind to **`effectiveSheetId`** (matching `activeFields`). This also corrects the returned `fieldPermissions` metadata on base-only.

**Inventory correction (vs the design's 10):** the **form-share** endpoints (GET/PATCH/regenerate) build a `view` internally but **return `serializePublicFormShareConfig(view)`** (token/status/accessMode — **no `filterInfo`**), so they are **not** leak vectors. The actual echoes are the **7** above.

## 2. Fail-first proof (real DB)

`tests/integration/multitable-viewconfig-filter-literal-redaction.test.ts`, wired into `plugin-tests.yml`.

**Pre-fix (unmodified `a3ba6afde`):** `Tests 7 failed | 2 passed (9)` — every echo leaked the literal:
```
× R1 GET /context?baseId= (authed, base-only)   → SECRET_LIT present
× R2 GET /views                                  → present
× R3 GET /view · × R4 GET /records               → present
× R5 GET /form-context (ANONYMOUS)               → present  [positive control: status 200 + fields → endpoint DID return the view]
× R6 cross-user (denied side)                    → present
× R9 PATCH /views/:viewId (canManageViews)       → present  [positive control: status 200, view returned]
✓ sentinel, R7 (ungranted user sees literal)
```
**Post-fix:** `Tests 9 passed`. The positive controls held (R5 anonymous reached the view; R9 PATCH succeeded), so the REDs were genuine leaks, not refused requests.

Fences three fail-open vectors, each its own assertion: **R5** anonymous `/form-context` (empty set, fail-closed — all literals absent incl readable ones); **R1** authed base-only `/context` (`effectiveSheetId` binding); layer-2 `property.hidden` literal absent + layer-1 view-hidden literal **present** (R3/R7 — composite, layer-1 stays). **R6** is the advisor-flagged **pure-helper / cross-user cache** guard: denied user → redacted, then readable user on the **same cached view** → literal **present** (no shared-object mutation).

## 3. Compat scan (the §2.1 precondition — completed) + wire shape

- **`MetaViewManager.vue`** consumes view `filterInfo` and is **tolerant of an omitted value** (loads `value: item.value`, renders `:value="rule.value ?? ''"`, a fresh unary condition already uses `value: undefined`).
- **`MetaAutomationRuleEditor.vue`** is **not a consumer** of view `filterInfo` (its conditions are the automation rule's own model).
- (grid `useMultitableGrid.ts:492-496` already tolerant.)
→ **wire shape = OMIT the `value` key** (no sentinel needed).
- **Write-path re-save edge CONFIRMED real** (your #2): `MetaViewManager` save sends `value: condition.value` (846) — `undefined` for a redacted condition → editing+re-saving such a view would silently null the denied field's saved literal. **Deferred** to the separate write-path-guard opt-in (this slice is read-path only); the evidence now exists.

## 4. Regression — clean
- **tsc**: clean on the touched file.
- **view-aggregate · #2028 records-read-mask · #2044 readpath-search · formula dry-run · the new test**: 5 files green together (the helper + the `/context` `fieldScopeMap` rebinding don't regress siblings).
- `d3d1`/`d3d2` skip-or-fail locally only on the known pre-existing schema gaps; green in CI's fresh DB.

## 5. Scope & deferred
**In scope (done):** redaction at all 7 view-config echoes; pure/field-perm-aware/fail-closed; `/context` `effectiveSheetId` binding; value-only/omit-value.
**Deferred (separate opt-ins):** the **write-path re-save guard** (server preserves a denied field's saved literal on re-save — now evidenced real); full field-def strip (ii); other layer-2-only read sites. Mechanism note: kept the surgical **helper-at-each-site** (not a centralized `serializeViewConfig`) — create/update build views differently, so consolidation would spread regression to non-leak endpoints (advisor #4).

## 6. Gated TODO
- ✅ Impl (pure helper + 7 echo sites + `/context` `effectiveSheetId` binding + fail-closed anonymous).
- ✅ R1–R9 real-DB fail-first (incl. R5 anonymous, R6 cross-user cache, R1 base-only); wired into `plugin-tests.yml`.
- ✅ Compat scan complete (omit-value); golden-doc note.
- 🔒 Write-path re-save guard — separate opt-in (evidenced real).
- 🔒 full field-def strip (ii) · other read sites — separate.
