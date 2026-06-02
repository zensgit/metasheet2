# D1 — form-context / form-submit echo field mask — verification

**Slice:** D1 (final finding) of the multitable field-read-gate arc. **Design-lock:** `multitable-form-context-submit-field-mask-design-20260602.md`. **Date:** 2026-06-02 · **Pattern:** layer-3 echo gate, fail-first.

## The leak
`GET /form-context?recordId=` and `POST /views/:viewId/submit` echo `record.data` masked by `visible*FieldIds` = **layer-1 ∧ layer-2 only** — not the subject-scoped layer-3 (`field_permissions.visible`) gate `/view`+`/records/:id` enforce (#2028). form-context loads `fieldScopeMap` but uses it only for metadata; submit loads none. So an **authenticated** field-denied caller reads a denied field's value via either path. Anonymous is moot (no subject; public can't load/update existing records → 400). Full rationale: the design doc.

## The fix (`packages/core-backend/src/routes/univer-meta.ts`)
- **form-context:** `readableFieldIds = visibleFields.filter(f => fieldPermissions[f.id].visible !== false)` (the already-computed layer-1∧2∧3 composite) → used for the `record.data` + attachment-summary masks.
- **submit:** added `loadFieldPermissionScopeMap` → `echoFieldPermissions` → `readableEchoFieldIds` → used for the `record.data` mask, attachment mask, **and the recalculated-formula overlay** (the server-assigned path).
- Anonymous (`effectiveAccess.userId=''`) → empty scope map → both sets equal the prior `visible*FieldIds` → public-form path unchanged.
- Untouched: write-validation gates (layer-2, correct — write-only-no-read preserved), central RBAC/auth, record-level read-deny (K3 Stage-1 lock).

## Fail-first evidence
`tests/integration/multitable-form-context-submit-field-mask.test.ts` (real DB). Seed (deny solely layer-3, `property={}`): `FLD_VISIBLE` (readable control), `FLD_SECRET` (string, denied to USER), `FLD_FORMULA` (`={FLD_VISIBLE}+1`, denied to USER, + `formula_dependencies` row), a record `{FLD_VISIBLE:'v0', FLD_SECRET:canary}`, and a `form` view with `config.publicForm` enabled (for C6).

| Case | Path | Assertion | Pre-fix |
|---|---|---|---|
| C1 | form-context `recordId` (USER) | `record.data[FLD_SECRET]` undefined + body ∌ canary; `FLD_VISIBLE` present | **RED** (canary leaked) |
| C2 | form-context `recordId` (USER_2) | `record.data[FLD_SECRET]` === canary (per-subject) | green |
| C3 | submit UPDATE echo (USER) | `record.data[FLD_SECRET]` undefined (not submitted, resurfaced) | **RED** |
| C4 | submit CREATE echo (USER) | `record.data[FLD_FORMULA]` undefined — **server-assigned, never sent** | **RED** (leaked `43`) |
| C5 | submit CREATE echo (USER_2) | `record.data[FLD_FORMULA]` present (non-vacuous channel) | green |
| C6 | anonymous public CREATE | `record.data[FLD_FORMULA]` present — **fix is a no-op for anonymous** | green |

RED on unmodified `origin/main` (C1/C3/C4 leak; sentinel + C2/C5/C6 pass) → **7/7 GREEN** after the fix.

## Regression
- `tsc` (core-backend) — exit **0**.
- Real-DB neighbors **31/31** — new test 7/7, `records-read-field-mask` 8/8, `write-echo` 5/5, `create-echo` 4/4, `records-summary` 7/7.
- Gating real-DB `viewconfig-filter-literal-redaction` (covers form-context's filter-literal echo) — **10/10**, unaffected.
- `field-validation-flow` 15/15 · `public-form-flow` (mocked) **22/22** (already stubs `field_permissions`).
- **Mock-stub cascade (F4 lesson):** the submit handler's new `loadFieldPermissionScopeMap` query broke **one** mocked test — `sheet-realtime.api` "publishes … after form submit" (baseline 3/3 → 1 failed: unhandled `SELECT … FROM field_permissions`). Fixed by adding a `field_permissions → []` stub to that test's dispatcher → back to **3/3**. Verified by running **every** mocked test that hits `/submit` or `/form-context`, not just the new one. `record-form.api` 8==8 and `sheet-permissions.api` 1==1 confirmed **pre-existing** (stash-baseline; not net-new).

## CI wiring & tracker
- `plugin-tests.yml` — `multitable-form-context-submit-field-mask.test.ts` added to the real-DB integration step.
- Tracker §2b: **D1 → ✅🔒** (locking test `multitable-form-context-submit-field-mask`); completion **12/12 — arc COMPLETE**. Every record-cell-value egress channel now applies the field-read gate (or is scan-clean), each backed by a real-DB locking test except the kanban/gallery/calendar scan-clean coverage item.
