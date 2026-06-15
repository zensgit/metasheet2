# Multitable Cross-Base FE Picker / Switcher — Design-Lock (2026-06-14)

Status: **DESIGN-LOCK (docs-only, no code).** Makes the merged cross-base backend
user-reachable from the frontend. Scopes the MVP slice; defers the rest.

## 1. What is already true (grounding)

The cross-base backend is **fully merged to `origin/main`** (PR chain
#2582 → #2585 → #2587 → #2588 → #2597). FE-relevant contract:

- **Link field cross-base read** — the field property stores `foreignBaseId` **only when both
  `foreignSheetId` and `foreignBaseId` are present** (opt-in; same-base links carry no
  `foreignBaseId`). Codec: `packages/core-backend/src/multitable/field-codecs.ts:208-229`.
- **`link-options` is base-read-gated** — `GET /api/multitable/fields/:fieldId/link-options`
  (`packages/core-backend/src/routes/univer-meta.ts:9240-9374`) detects cross-base from the
  field's stored target and, when cross-base, requires `resolveBaseReadable`; otherwise returns
  **403**. Params: `recordId/search/limit/offset` — **no `baseId` param** (backend resolves the
  foreign sheet+base from the field). The FE client mirror takes the same params:
  `listLinkOptions(fieldId, {recordId,search,limit,offset})` — `apps/web/src/multitable/api/client.ts:1362-1367`.
- **Bases list is already readable-scoped** — `GET /api/multitable/bases`
  (`univer-meta.ts:4249-4291`) returns only bases with ≥1 readable sheet. FE:
  `client.listBases()` — `client.ts:760-763`.
- **`loadContext({baseId})` returns that base's `sheets`** (base-read-gated) — `MetaContext.sheets`
  (`apps/web/src/multitable/types.ts:186-195`); client `loadContext` — `client.ts:789-792`.
- **Cross-base automation write** — `UpdateRecordConfig` / `CreateRecordConfig` accept
  `targetBaseId` / `targetSheetId` / `targetRecordId`
  (`packages/core-backend/src/multitable/automation-actions.ts:36-62`); gated by
  `evaluateCrossBaseWrite` + a per-target-base write **quota** (default 60 writes / 60 s, env
  `CROSS_BASE_WRITE_QUOTA_*`) in `automation-executor.ts`.

**Today's FE has no cross-base affordance** — confirmed: `foreignBaseId` appears **nowhere** in
`apps/web/src/multitable/`, and none of #2582/#2585/#2597 touched `apps/web` (all backend/openapi/test
only). The link-field editor (`MetaFieldManager`) picks the foreign sheet from a `<select>` over
`targetSheets = props.sheets.filter(id !== sheetId)` (`MetaFieldManager.vue:90,targetSheets computed`)
— **same-base only** — and the save-guard at `MetaFieldManager.vue:1747` **rejects** any
`foreignSheetId` not in same-base `targetSheets`. `props.sheets` is `workbench.sheets.value`
(`MultitableWorkbench.vue:369`), which is **active-base only**
(`useMultitableWorkbench.ts:119,155-156`). So a user cannot author a cross-base link, and
opening/saving an already-cross-base field would break.

## 2. Own principles for this surface

- **Opt-in, backward-compatible.** Same-base stays the default and the no-extra-click path; cross-base
  is an explicit toggle. Emit `foreignBaseId` **only** when cross-base is chosen (mirrors the codec).
- **The base-read gate is the FE's source of truth, not a second rule.** We never compute our own
  readability — we only ever offer what `listBases()` / `loadContext({baseId})` already return, and we
  surface the backend's 403 verbatim-but-friendly. Unreadable foreign sheets are simply absent.
- **Reuse the existing read path; add no endpoint.** `listBases()` + `loadContext({baseId}).sheets`
  already give a gated base→sheet picker. No `baseId` param needs to be added to `link-options`.
- **Immutability is honored in the UI.** Once a field's `foreignBaseId` is set, the base axis is
  read-only in edit mode (the backend treats the target base as fixed).
- **Tight, not a rework.** A plain base `<select>` + sheet `<select>` behind a checkbox — we do **not**
  reuse the workbench `MetaBasePicker` (favorites/create/search switcher is overkill in a field config).

## 3. MVP slice (the first reviewable FE PR)

**Cross-base LINK field picker in `MetaFieldManager` (read side) — config-authoring only.**

In the `link` branch of the field config (`MetaFieldManager.vue:87-99`):

1. Add a checkbox **"Link to another base"** (default off → same-base, unchanged).
2. When **on**: a base `<select>` sourced from `client.listBases()`, then a foreign-sheet `<select>`
   sourced by calling `client.loadContext({ baseId })` on base-pick and using its `.sheets`
   (excluding the current sheet only when base === current base). Loading/empty/403 states inline.
3. Save assembles the link property with `foreignBaseId` + `foreignSheetId` (cross-base) or just
   `foreignSheetId` (same-base, exactly as today). Touch points:
   `MetaFieldManager.vue:1747-1753` (save assembly + the same-base guard — see §4),
   `MetaFieldManager.vue:linkDraft reactive + :1212` (`linkDraft` shape + reset),
   `MetaFieldManager.vue:1376` (load draft from existing property).
4. **FE normalizer carries the field through** — add `foreignBaseId` to
   `NormalizedLinkFieldProperty` and `resolveLinkFieldProperty`
   (`apps/web/src/multitable/utils/field-config.ts:8-12,94-99`). Without this the picker emits the
   field but read-back drops it and the link silently reverts to same-base on reload — the #1781
   wire-vs-fixture trap. This is **test-row #1**, not a footnote.

The MVP needs **no new endpoint, no base-navigation rework, and no `MetaLinkPicker` change** (see §6).
The FieldManager is emit/fn-prop based, so the base/sheet fetch enters via a **fn-prop**
(`listForeignSheetsFn(baseId)` resolved in `MultitableWorkbench.vue` from `client.loadContext`),
mirroring the existing `dryRunFn` / `aiPreviewFn` precedent (`MetaFieldManager.vue:372-377`,
`MultitableWorkbench.vue:1843`). The fn-prop also supplies `listBasesFn()`.

> **Impl trap (lock this):** the foreign-sheet fetch MUST call **raw `client.loadContext({baseId})`**,
> NOT `workbench.loadBaseContext` / `workbench.switchBase` — the latter two run `syncContextState`
> (`useMultitableWorkbench.ts:205,187,221-234`) which would **yank the user's active base/sheet** out
> from under the field config. The fn-prop in `MultitableWorkbench.vue` must close over the bare
> client, not the workbench mutators.

**Why this slice is independently valuable:** once a field is authored cross-base, users can
**immediately populate it** through the existing record-value picker `MetaLinkPicker` — it already
works for cross-base reads unchanged (§6). So the MVP delivers the full author-and-use loop for
cross-base links without a second slice.

## 4. Edit-mode correctness (in MVP, not polish)

Opening or saving an **existing** cross-base field must not break:

- **Display.** In edit mode, resolve the stored `foreignBaseId`'s name (from `listBasesFn()`) and the
  `foreignSheetId`'s name (from `loadContext({foreignBaseId}).sheets`); show them selected with the
  cross-base toggle on.
- **Base axis read-only (immutability).** The base `<select>` is disabled in edit mode; only the
  sheet within the locked base may change. (Same-base ↔ cross-base re-targeting after create is out of
  MVP scope.)
- **Make the save-guard base-aware.** `MetaFieldManager.vue:1003` currently rejects any
  `foreignSheetId` not in same-base `targetSheets`. It must accept a cross-base `foreignSheetId`
  validated against the **fetched foreign-base sheet list** instead.
- **Foreign base became unreadable.** If `loadContext({foreignBaseId})` 403s, render a read-only gated
  state showing the stored IDs and a "you no longer have access to the linked base" notice — never a
  blank/crashing select.

## 5. Interactions with backend invariants

| Invariant | FE behavior |
|---|---|
| Base-read gate (`link-options` 403; `listBases`/`loadContext` filter) | Only readable bases/sheets are offered; a foreign sheet the user can't read is **not selectable**; record-load 403 shows a friendly message. |
| `foreignBaseId` set only when both present (codec) | Emit `foreignBaseId` **only** when the cross-base toggle is on and a foreign sheet is chosen. |
| `foreignBaseId` immutability | Base axis disabled in edit mode (§4). |
| Cross-base **automation** write quota (60/60 s) | **Informational only** in the deferred automation slice — one line near the target selectors; **no FE enforcement** (the backend rejects over-quota writes). |

## 6. Slice boundary — `MetaLinkPicker` needs no change

`MetaLinkPicker` (the record-value picker, `apps/web/src/multitable/components/MetaLinkPicker.vue`)
calls `listLinkOptions(props.field.id, {...})` (`:107`) and renders the returned records; it resolves
**nothing** from local same-base `sheets`, and it already surfaces backend errors via `errorMessage`
(`:25,121-123`). Because `listLinkOptions` takes no `baseId` and the backend resolves the foreign
sheet+base (403 on no-read), **cross-base reads work through it unchanged**. The only future polish is
a friendlier 403 string than the raw backend message — captured as a slice-2 nicety, **not** an MVP
dependency.

## 7. Deferred (named, with pre-scoped anchors)

- **Cross-base AUTOMATION target selectors.** In `MetaAutomationRuleEditor.vue`, add optional
  `targetBaseId` + `targetSheetId` (+ `targetRecordId` for `update_record`) selectors when a
  cross-base write is configured, plus the informational quota line.
  - `create_record` block (`MetaAutomationRuleEditor.vue:268-278`) already has a `targetSheetId` text
    input at `:270-271`; add `targetBaseId` beside it.
  - `update_record` block (`MetaAutomationRuleEditor.vue:255-266`) has **no** target selector today
    (only `fieldUpdates` pairs at `:257-263`); a `targetBaseId`+`targetSheetId`+`targetRecordId` group
    must be added for cross-base updates.
- **`MetaLinkPicker` 403-message polish** (§6) — friendly "linked base unreadable" copy.
- **Full base-navigation rework** — the workbench switcher (`MetaBasePicker`) already exists; no
  cross-base-driven rework is in scope.
- **Same-base ↔ cross-base re-targeting after create** — gated by `foreignBaseId` immutability.

## 8. Fail-first FE test matrix (jsdom / Vitest `*.spec.ts` under `apps/web/tests/`)

New spec: `apps/web/tests/multitable-crossbase-link-picker.spec.ts` (component-level on
`MetaFieldManager`), plus normalizer unit coverage alongside `multitable-field-config-i18n.spec.ts`.

| # | Scenario | Assertion (must fail before impl) |
|---|---|---|
| 1 | **Round-trip (wire-vs-fixture)** | create link with cross-base toggle on → emitted `create-field` property carries `foreignBaseId` **and** `foreignSheetId`; feed that property back through `resolveLinkFieldProperty` → `foreignBaseId` survives (proves no silent revert). |
| 2 | Same-base default | toggle off (default): emitted property has `foreignSheetId` only, **no** `foreignBaseId` key. |
| 3 | Base list source | toggle on calls `listBasesFn`; picking a base calls `listForeignSheetsFn(baseId)` and the sheet `<select>` shows only those sheets. |
| 4 | Cross-base save-guard | a `foreignSheetId` valid in the **foreign** base (not in same-base `targetSheets`) is accepted (no `fieldConfigError`). |
| 5 | Edit immutability | open existing cross-base field → cross-base toggle on, base `<select>` **disabled**, both names shown selected. |
| 6 | Unreadable foreign base | `listForeignSheetsFn`/loadContext rejects (403) → read-only gated state with stored IDs + notice; **no** crash, **no** silently-same-base save. |
| 7 | Reset on close/reopen | `linkDraft` (incl. `foreignBaseId`) resets so a new field doesn't inherit a stale foreign base. |
| 8 | **Active base unchanged** | configuring a cross-base field (toggle on → pick base → pick sheet) does **not** change the workbench active base/sheet — proves the foreign-sheet fetch used raw `loadContext`, not `switchBase`/`loadBaseContext`. |

## 9. Decisions (recommended defaults)

1. **MVP = link-config-picker only** (defer automation `targetBaseId` selectors + base-nav). It is the
   most visible surface, end-to-end valuable via the unchanged record-value picker, and lowest-risk.
   **Default: link-picker-only.**
2. **Base-list source = existing read APIs, no new endpoint** — `client.listBases()` for the base list,
   `client.loadContext({ baseId }).sheets` for the foreign-base sheet list; both already base-read
   gated. **Default: reuse `listBases` + `loadContext`.** (`link-options` deliberately takes no
   `baseId`, so it is for an existing field's target, not for picking a new one.)
3. **Same-base remains the default; `foreignBaseId` emitted only when cross-base is toggled** — matches
   the codec's both-present rule and preserves backward compatibility. **Default: opt-in toggle, off by
   default.**

## 10. Out of scope / unchanged

No backend change, no new endpoint, no OpenAPI change (the contract is merged). No central
RBAC/auth touch. No `MetaLinkPicker` change in MVP. No code in this PR — design-lock only.
