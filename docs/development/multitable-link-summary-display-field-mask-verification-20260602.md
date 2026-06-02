# `buildLinkSummaries` foreign-display-value field mask — verification (F5 review follow-up)

**Slice:** review follow-up to F5 of the multitable field-read-permission-gate arc (tracker `docs/development/multitable-field-read-gate-tracker-20260602.md` §2b).
**Origin:** independent review of #2198 (F5) surfaced a second, distinct egress on `link-options` (`data.selected`) — investigation showed it is a shared-helper leak across **four** surfaces, not one branch.
**Date:** 2026-06-02 · **Risk:** Med · **Pattern:** root-cause fix in the shared helper, fail-first.

---

## 1. The leak

`buildLinkSummaries` derives each linked foreign record's `display` from the **foreign sheet's default display field** and echoes it into `linkSummaries` / `selected`. It gated **sheet-level** read (`resolveReadableSheetIds`) but picked the display field as `fields.find(type==='string') ?? fields[0]` and read `data[displayFieldId]` with **no field-level mask**. So when the *link field* is readable but the *foreign sheet's display field* is `field_permissions.visible=false` for the caller, the denied value leaked on every consumer of the helper:

| Surface | Response shape |
|---|---|
| `GET /view` (records-list) | `data.linkSummaries[recordId][fieldId][].display` |
| `GET /records/:recordId` (single-record read, #2015 path) | `data.linkSummaries[fieldId][].display` |
| `GET /fields/:fieldId/link-options?recordId=` | `data.selected[].display` |
| write/patch echo (`RecordWriteService`, F3 path) | `data.linkSummaries[…].display` |

The existing `filterRecordFieldSummaryMap` / `filterSingleRecordFieldSummaryMap` wrappers only drop summaries for *link fields* the caller can't read (top-level `fieldId` keys, caller-side) — they never touch the foreign `display` **value**. This is the **complement** of `records-read` R6 (which denies the *link field*, so the whole summary key drops); here the link field is visible and only the foreign display field is denied.

**Why F5 (#2198) didn't catch it:** F5 gated the `loadRecordSummaries` path (`link-options` `data.records` + `people-search`). `data.selected` and the other `linkSummaries` surfaces come from a *different* helper (`buildLinkSummaries`), and the original #2106 grep set keyed on `loadRecordSummaries` / `data[fieldId]`, not on derived foreign-keyed display values. (Tracker §3 Layer-3 grep set updated with this lesson.)

## 2. The fix

`packages/core-backend/src/routes/univer-meta.ts`, inside `buildLinkSummaries`, the per-foreign-sheet display-field selection loop now consults **that foreign sheet's own** layer-2 ∧ layer-3 allowed set for the requester, and picks the display field only from it:

```ts
const fields = await loadFieldsForSheet(query, sheetId)
const { access, capabilities } = await resolveSheetReadableCapabilities(req, query, sheetId)
const allowedFieldIds = await loadAllowedFieldIds(query, sheetId, access.userId, capabilities)
const allowedFields = fields.filter((field) => allowedFieldIds.has(field.id))
const stringField = allowedFields.find((field) => field.type === 'string')
displayFieldBySheet.set(sheetId, stringField?.id ?? allowedFields[0]?.id ?? null)
```

Selecting the display field only from allowed fields makes the later `data[displayFieldId]` read inherently safe (no separate value gate needed). Same primitives as F5 (`resolveSheetReadableCapabilities` + `loadAllowedFieldIds`), keyed to the **foreign** sheet + requester — the crossSheetRelated per-sheet-keying rule. One root fix closes all four surfaces.

**Admin-safe (verified, not assumed):** there is **no admin bypass for field visibility** anywhere — `deriveFieldPermissions` computes `visible = baseVisible && (scope?.visible ?? true)`; `capabilities` only affects `readOnly`, and `computeAllowedFieldIds` reads only `.visible`. So visibility masking depends solely on `(sheetId, userId)` via `field_permissions` (the same uniform semantics as the #2015 read path), and an admin / ungranted user with no deny row still sees the value. No new query shapes; **K3 Stage-1-lock-safe** (no central RBAC/auth touched).

## 3. Fail-first evidence

New real-DB test: `packages/core-backend/tests/integration/multitable-link-summary-display-field-mask.test.ts`.

**Seed** (deny solely layer-3 — `property = {}`): `SHEET_A` (source) + readable `FLD_LINK` (link → `SHEET_B`) + `REC_A`; `SHEET_B` (foreign) + `FLD_B_DISPLAY` (string default display, `B_CANARY`, **denied to USER on `SHEET_B`**) + `REC_B`; `meta_links(FLD_LINK, REC_A, REC_B)`. `USER_2` has no deny (positive control). The link field is **not** denied — so the leak is purely the surviving summary's `display`.

**Cases** (each positive-control-first to defeat an empty-summary false-green):
- `sentinel` — `DATABASE_URL` set.
- `S1` `GET /view` — USER_2 gets `linkSummaries[REC_A][FLD_LINK][0].display === B_CANARY`; USER gets the **same summary entry** (`id === REC_B`, proving the link-field key survives — not the R6 case) but `display !== B_CANARY` and `B_CANARY` is nowhere in the body.
- `S2` `GET /records/:recordId` — same on the single-record `linkSummaries[FLD_LINK]`.
- `S3` `GET /fields/:fieldId/link-options?recordId=` — same on `data.selected` (find by `id === REC_B`).
- `S4` `POST /patch` (write-echo) — patch a readable bystander field on `SHEET_A` (write perm) so `RecordWriteService` rebuilds `linkSummaries` for `REC_A`; same mask assertion on `data.linkSummaries[REC_A][FLD_LINK]`. (`PATCH /records/:recordId` echoes link *IDs*, not summaries — so `POST /patch` is the write-echo `linkSummaries` surface.)

**Result:** RED on the un-fixed helper (S1–S4 **all four** leak `B_CANARY`; sentinel passes) → **5/5 GREEN** after the fix. All four surfaces listed in the tracker row now carry a real-DB assertion.

## 4. Regression scope

- `tsc` (core-backend) — exit **0**.
- Real-DB neighbors that exercise `buildLinkSummaries` / the changed routes — **33/33**: `records-read-field-mask` **8/8** (incl. R6 link-field-denied — the orthogonal case still drops the whole key), `summary-display` (F5) 5/5, `records-summary` (F2) 7/7, `write-echo` 5/5, `create-echo` 4/4, `cross-sheet-related-echo` 4/4.
- **Mocked-suite cascade check (the F4-lesson / advisor):** the new field-perm queries fire only when a sheet has link fields + linked records; `buildLinkSummaries` early-returns otherwise, so the mocked tests are unaffected. Verified by stash-diff: combined mocked run was **identical to baseline** (9 failed | 60 passed). Gating mocked suites pristine — `sheet-permissions.api` **1 failed / 40 passed** (the pre-existing F2-era records-summary case, out of scope) and `sheet-realtime.api` **3/3** — both unchanged from baseline. `record-form.api` retains its 8 pre-existing (non-gating) failures, unchanged.

**Gating suites unaffected.** The real-DB locking suite gains one test; no existing locking test changed behavior.

## 5. CI wiring & tracker

- `.github/workflows/plugin-tests.yml` — `tests/integration/multitable-link-summary-display-field-mask.test.ts` added to the real-DB integration step (after the F5 test). Runs on every PR ⇒ a future drop of the per-foreign-sheet gate turns this **RED and blocks merge**.
- Tracker §2b: F5 row made precise (`loadRecordSummaries` display: link-options `data.records` + people-search); **new row** for this `buildLinkSummaries` finding (locking test `multitable-link-summary-display-field-mask`). Completion **10 / 12**; every High + Med + Low leak channel closed. §3 Layer-3 grep set + lesson updated.
