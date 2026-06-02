# F5 — record-summary display-value field mask (cross-sheet read paths) — verification

**Slice:** F5 of the multitable field-read-permission-gate arc (tracker: `docs/development/multitable-field-read-gate-tracker-20260602.md`, §2b).
**Design-lock:** `docs/development/multitable-record-egress-fieldperm-inventory-20260529.md` (#2106) §F5.
**Date:** 2026-06-02 · **Risk:** Low · **Pattern:** direct impl slice, fail-first (like F2 #2157).

---

## 1. The leak

`loadRecordSummaries(query, sheetId, opts)` derives a per-record **`display`** string from a *display field*. When the caller passes no `displayFieldId`, it picks a **default** display field — the sheet's primary/first field. F2 (#2157) gated the caller-controlled `displayFieldId` on `GET /records-summary` **and** started passing `allowedFieldIds` so the default is chosen only from readable fields.

But two **cross-sheet** callers still passed **no `allowedFieldIds`**, so the default display field of the *target* sheet was picked without consulting field permissions — and its cell value was echoed via `display`:

| Site | Target sheet | Leak |
|---|---|---|
| `GET /fields/:fieldId/link-options` | the **foreign** sheet (`linkConfig.foreignSheetId`) | foreign sheet's default display field value |
| `GET /people-search` | the **people** sheet (`description = '__metasheet_system:people__'`) | people sheet's default display field value |

Because the default display field is keyed to **that** sheet (not the caller's sheet), a `field_permissions.visible = false` field on the foreign/people sheet leaked its value through `display` even though every other egress on that sheet is gated. This is the **crossSheetRelated per-sheet-keying** lesson (#2176/#2178): mask by *that* sheet's own `allowedFieldIds`, not the caller's.

`person-fields/prepare` itself (the `GET /person-fields` prepare path) returns a static preset (`targetSheet` + `fieldProperty`) and does **not** call `loadRecordSummaries` — the live summary-display site is `GET /people-search`. The tracker row name is corrected accordingly (`person-fields/prepare` → `people-search`).

## 2. The fix

Both callers now load the **target sheet's own** layer-2 ∧ layer-3 readable set and pass it to `loadRecordSummaries`, so the default display field is chosen only from fields the caller may read — and a denied default is skipped (or, when present as an explicit value, omitted) rather than echoed.

`packages/core-backend/src/routes/univer-meta.ts`:

- **`link-options`** — capture the foreign sheet's access alongside capabilities, then load that sheet's allowed fields:
  ```ts
  const { access: foreignAccess, capabilities } =
    await resolveSheetReadableCapabilities(req, pool.query.bind(pool), linkConfig.foreignSheetId)
  // …
  const foreignAllowedFieldIds = await loadAllowedFieldIds(
    pool.query.bind(pool), linkConfig.foreignSheetId, foreignAccess.userId, capabilities)
  // passed to loadRecordSummaries(..., { allowedFieldIds: foreignAllowedFieldIds })
  ```
- **`people-search`** — same shape against the people sheet:
  ```ts
  const { access, capabilities } = /* resolveSheetReadableCapabilities(... peopleSheetId) */
  const peopleAllowedFieldIds = await loadAllowedFieldIds(query, peopleSheetId, access.userId, capabilities)
  // passed to loadRecordSummaries(query, peopleSheetId, { search: q, limit, offset: 0, allowedFieldIds: peopleAllowedFieldIds })
  ```

`loadAllowedFieldIds` is the shared helper (introduced in this arc): returns an empty set when `!userId || !sheetId` (fail-closed), else `loadFieldsForSheet` + `loadFieldPermissionScopeMap` → `computeAllowedFieldIds`. `loadRecordSummaries` already honors `allowedFieldIds` (added in F2): `selectableFields = fields.filter(f => allowedFieldIds.has(f.id))` for default-display selection, while an explicit `displayFieldId` is still gated at the caller.

No new query shapes, no central RBAC/auth touched — K3 Stage-1-lock-safe.

## 3. Fail-first evidence

Real-DB integration test (new): `packages/core-backend/tests/integration/multitable-summary-display-field-mask.test.ts`.

**Seed** (deny is solely layer-3 — denied fields' `property = {}`, no `hidden`):
- `SHEET_A` (source) + `FLD_LINK` (link → `SHEET_B`); `SHEET_B` (foreign) + `FLD_B_DISPLAY` (string, default display, value `B_CANARY`) + `REC_B`.
- `PEOPLE_SHEET` (`description = '__metasheet_system:people__'`) + `FLD_P_NAME` (string, default display, value `P_CANARY`) + `REC_P`.
- `field_permissions` deny `FLD_B_DISPLAY` (on `SHEET_B`) and `FLD_P_NAME` (on `PEOPLE_SHEET`) for `USER` only; `USER_2` has no deny (positive control).

**Cases:**
- `sentinel` — `DATABASE_URL` set (fails-not-skips).
- `R1` (link-options, USER) — `rec.display !== B_CANARY` **and** whole body excludes `B_CANARY`, **and** `REC_B` is still listed (positive control: not an empty response). ← **THE LEAK, RED pre-fix.**
- `R2` (link-options, USER_2 positive) — `display === B_CANARY` (mask is per-subject, not a blanket strip).
- `R3` (people-search, USER) — `item.display !== P_CANARY` and body excludes `P_CANARY`, item present. ← **THE LEAK, RED pre-fix.**
- `R4` (people-search, USER_2 positive) — `display === P_CANARY`.

**Result:** RED on unmodified `origin/main` (R1 + R3 canaries present) → **5/5 GREEN** after the fix.

## 4. Regression scope

- `tsc` (core-backend) — exit **0**.
- F2 sibling `multitable-records-summary-field-mask` — **7/7** (the same-helper neighbor: unchanged).
- `record-form` real-DB suite — **8 = 8** (no net-new failure).
- `multitable-sheet-permissions.api` (mocked, in the real-DB step) — F5's new `loadAllowedFieldIds` in `link-options` issued two queries the "allows link options" mock dispatcher didn't stub (a `meta_fields` order-select + a `field_permissions` lookup) → 1 → 2 failures. Restored to **pristine 1 failed / 40 passed** by adding two handlers to that test's create dispatcher (return one `string` field with `property: {}`, and `field_permissions` → `[]`). The one remaining failure is the pre-existing F2-era records-summary case, out of F5 scope.

**Gating suites unaffected.** The real-DB locking suite (`plugin-tests.yml` "multitable real-DB integration") gains one test; no existing locking test changed behavior. The mocked `sheet-permissions` and `sheet-realtime.api` cases in that step were re-confirmed (the F4-lesson: every mocked test that hits the changed route was re-run, not just the new one).

## 5. CI wiring & tracker

- `.github/workflows/plugin-tests.yml` — `tests/integration/multitable-summary-display-field-mask.test.ts` added to the real-DB integration step (after `multitable-records-summary-field-mask.test.ts`). It runs on every PR against freshly-migrated Postgres with the `DATABASE_URL` hard-guard + sentinel ⇒ a future drop of either `allowedFieldIds` pass-through turns this **RED and blocks merge**.
- Tracker §2b: **F5 → ✅🔒** (locking test `multitable-summary-display-field-mask`); completion **9 / 11**; "every High + Med + Low leak channel is closed." Remaining = D1 (design question) + kanban/gallery/calendar (coverage scan), each a separate explicit opt-in.
