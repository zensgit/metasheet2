# Multitable view-config filter-literal redaction (priority-#2 (b)) — design-lock

- **Slice**: priority-#2 **(b)** — the *literal-in-payload* half of the #2015 deferred same-class set. A saved view's `filterInfo.conditions[].value` (the comparison **literal**) is echoed **verbatim** wherever a view config is serialized to a user, so a user denied a field via `field_permissions.visible=false` can read that field's filter literal (e.g. a view filtering `Salary = "120000"` leaks `"120000"`).
- **Sibling**: (a) — search/sort/filter **selection** — is DONE (#2038 design / #2044 impl). (a) closed the *behavioral* channel (which rows / order / count) and explicitly left this *literal* channel to (b). (a) also confirmed: `computedFilterSort` is a boolean and the gated `filterInfo` is apply-only, so the **only** filter-literal echo is the raw `view: viewConfig` — this slice.
- **Status**: 🔒 design-lock (this doc). Docs-only PR. Implementation is a **separate explicit opt-in** (not in this doc).
- **Date**: 2026-05-29
- **Grounding**: read-only worktree off `origin/main 0163cf855`; anchors verified at that tip.
- **Lock posture**: additive read-path **kernel-polish**. RBAC/auth, central permission model, `plugin-integration-core`, `src/formula/engine.ts` **NOT touched** ([[k3-poc-stage1-lock]]). Code↔contract reconciliation (the field-read gate must also cover the literal echo), not a new product model — lineage of #2015/#2024/#2038.

## 1. The gap (verified, anchored)

`parseMetaFilterInfo` retains the literal: `...(Object.prototype.hasOwnProperty.call(raw, 'value') ? { value: (raw as any).value } : {})` (`:1557`); `MetaFilterCondition = { fieldId; operator; value?: unknown }` (`:1470`). Every view-config response hand-rolls `filterInfo: normalizeJson(row.filter_info)` — the raw saved filter, **including** `conditions[].value` — with **no field-permission redaction**. A user with sheet `canRead=true` but a field denied via layer-3 receives that field's filter **literal** in the payload.

**Only `filterInfo.conditions[].value` is a literal leak.** The other view-config parts carry **field IDs**, not values: `sortInfo` = `{rules:[{fieldId, desc}]}`, `groupInfo` = `{fieldId}`, `config` (aggregations) = `{fieldId: fn}`, `hiddenFieldIds` = `[fieldId]`. A denied field's mere *presence* by ID is already metadata-known (the value-only #2015 model keeps `fields[]` defs + `fieldPermissions`), so it is **not** a new leak. (b) is therefore scoped precisely to **`filterInfo.conditions[].value` literals**, not fieldIds.

**Relationship to (a):** (a) gated which conditions are *applied* (and dropped denied ones from the computed apply path). It did **not** touch the raw `view: viewConfig` echo — by design, that is (b). So post-(a) the denied condition is no longer *applied*, but its literal still *ships* in the echoed config. (b) redacts the literal.

## 2. Inventory — every view-config serialization → response point (complete)

The redaction must cover **all** of these (no shared serializer exists today — each hand-rolls the view object):

| # | endpoint | return anchor | gate | class |
|---|---|---|---|---|
| 1 | `GET /context` | `views: serializedViews` (`:3558`, built `:3519`) | **canRead** | **primary — read-only user leaks** |
| 2 | `GET /views` (list) | `data: { views }` (`:5019`, built `:5012`) | **canRead** | **primary** |
| 3 | `GET /view` | `view: viewConfig` (`:6514`) | **canRead** | **primary** |
| 4 | `GET /records/:recordId` | `view: viewConfig` (`:7498`) | **canRead** | **primary** |
| 5 | `POST /views` (create) | `data: { view }` (`:5108`) | canManageViews | secondary — write-echo |
| 6 | `PATCH /views/:viewId` (update) | `data: { view }` (`:5213`) | canManageViews | secondary |
| 7 | `GET …/views/:viewId/form-share` | view + `filterInfo` (`:5252`) | canManageViews | secondary |
| 8 | `PATCH …/views/:viewId/form-share` | (`:5312` / `:5413`) | canManageViews | secondary |
| 9 | `POST …/form-share/regenerate` | (`:5465` / `:5491`) | canManageViews | secondary |
| 10 | **`GET /form-context`** (public form render) | `view: resolved.view` (`:6648`) | **public — anonymous-capable** (rate-limited) | **primary — HIGHEST severity (anonymous) + fail-open trap (§4)** |

The **primary** paths (1-4, canRead) are the authenticated read-only leak; **#10 (`GET /form-context`) is the worst** — it echoes the full `resolved.view` (filterInfo + literals) to a **possibly-anonymous** caller. The **secondary** five (5-9) are `canManageViews`-gated, where a *manages-views-but-field-denied* user still leaks (manage-views ⊋ field-read). The helper is **field-permission-aware** (§4) so it applies uniformly to all ten — the endpoint's coarse gate is irrelevant; redaction follows the **requester's** allowed-field set. **⚠️ #10 is the empty-map fails-open trap** (hit in #5c-a/#2015): an anonymous caller has no `fieldScopeMap`, and the authenticated default "empty map ⇒ no denials ⇒ show all" would leak **every** literal — so the helper MUST **fail closed** for no-subject (§4). (Inventory method: grep of all `data: { view(s) }` / `view: viewConfig` / `view: resolved.view` / `views: serializedViews` returns + all `filterInfo: normalizeJson(row.filter_info)` constructions at `0163cf855`. `getPublicFormConfig` (`:514`) returns a distinct `PublicFormConfig` of token/access fields — **not** `filterInfo` — so it is out of set. If a future endpoint serializes a `UniverMetaViewConfig` to a user, it joins this list and MUST route through the helper.)

## 3. Scope (locked — broad+)

- **broad+**: redact `filterInfo.conditions[].value` for denied fields at **every** view-config serialization point (the §2 inventory — **all** of it, incl. `GET /context`), not a subset. Narrow (`/view`+`/records` only) is rejected: `GET /context` / `GET /views` are the identical leak one call away for the same read-only user (the (a) view-aggregate-parity lesson — don't fix one face and leave the parallel hole).
- **mechanism**: a **shared, field-permission-aware helper** (§4) — **not** continued per-site hand-rolling. New view-config returns must use it. **(Impl tradeoff to weigh, advisory):** applying one helper at 10 hand-rolled sites means 10 places to remember + every future 11th (the recurring "miss one parallel path" trap this whole arc keeps hitting). A single `serializeViewConfig(row, allowedFieldIds)` that **all** paths call would make redaction *structural* rather than remembered — heavier (consolidating 10 inline constructions) but more robust. Impl should pick: helper-at-sites + a lint/test guard, vs a centralized serializer. Leaning centralized if the consolidation stays mechanical.
- **layer**: the **#2015 composite — layer-2 (`property.hidden`) ∧ layer-3 (`field_permissions.visible`)**, layer-1 excluded (**NOT** "layer-3 only": a `property.hidden` field is data-masked for everyone by #2015, so its filter literal is equally a leak; the composite catches it for free via `isFieldPermissionHidden`). A *readable-but-view-hidden* field's literal is **kept** (layer-1 display-only — the user can read that field).
- **value-only** (§4.1): redact the literal, keep `fieldId`+`operator`.

### Non-scope
- (a)'s selection gating (done, #2044). · `sortInfo`/`groupInfo`/`config`/`hiddenFieldIds` (fieldIds only, not literals — §1). · full field-def strip (ii). · the **write-path re-save edge** (§4.1, flagged not fixed). · RBAC/auth/integration-core/`engine.ts`.

## 4. The fix — `redactViewConfigFilterLiterals(view, allowedFieldIds)`

A shared helper applied to every `UniverMetaViewConfig` before serialization. It takes a **pre-computed `allowedFieldIds: Set<string>`** (the requester's allowed fields) — NOT the raw `fieldScopeMap` — so the **caller** owns the "what's allowed" decision (critical for the anonymous case):
- For each `filterInfo.conditions[]` whose `fieldId ∉ allowedFieldIds` → **redact its literal** (keep `fieldId`+`operator`; §4.1 wire shape).
- Leave allowed-field conditions, and all of `sortInfo`/`groupInfo`/`config`/`hiddenFieldIds`, untouched.

**How the caller computes `allowedFieldIds` (the fail-open fix):**
- **Authenticated requester** → the **#2015 composite**: `deriveFieldPermissions(fields, caps, { hiddenFieldIds: [], fieldScopeMap }).visible !== false` (reuse `allowedFieldIds`/#2044 `selectableFieldIds` **verbatim** — **layer-2 ∧ layer-3**, layer-1 excluded). An authenticated user with no field-permission rows correctly gets all-allowed (no denials ⇒ show literals).
- **Anonymous / no subject (`GET /form-context`, #10)** → pass an **EMPTY set** ⇒ **every** filter literal redacted (**FAIL CLOSED**). This is mandatory and is the crux: the discriminator is the **subject (`userId`), not the map**. Reusing the authenticated default for an anonymous caller (empty `fieldScopeMap` ⇒ "no denials" ⇒ show all) is the empty-map-fails-open trap (#5c-a/#2015) — anonymous would see *all* literals. No subject ⇒ nothing allowed ⇒ redact all.

**`fieldScopeMap` / fields plumbing.** Authenticated callers need the requester's `fieldScopeMap` + sheet fields to build `allowedFieldIds`: `/view` (#2015) and `GET /records` already load `fieldScopeMap`; **`GET /context` and `GET /views` use `resolveSheetCapabilities` and do NOT load a field-scope map** — they must (one per-subject query) for authenticated callers. `GET /form-context` (anonymous) skips the load entirely and passes the empty set. (Cost: one `loadFieldPermissionScopeMap` per authenticated view-config read on the two list paths — acceptable; same primitive already on the hot `/view` path.)

### 4.1 §2.1 — value-only; concrete wire shape is COMPAT-SCAN-GATED (do not hardcode before the scan)
**Decision: value-only** (redact the literal, keep `fieldId`+`operator` so the client can still render a "Field [hidden]" filter chip). **Leaning shape = OMIT the `value` key** (not `value: null`), mirroring `parseMetaFilterInfo`'s existing conditional `value` inclusion (`:1557`). But the **exact** wire shape is a **precondition gated on a completed compat scan** — do **not** hardcode `value: null` (or any shape) before it:
- **Scan finding so far (favorable, partial):** the grid parser `useMultitableGrid.ts:492-496` keeps a condition by `fieldId` and reads `value: c.value` → **tolerant of an absent/`undefined` value** (renders an empty filter row). So an omitted `value` does not break the grid.
- **Scan NOT yet complete — two consumers must be checked before impl finalizes the shape:** `MetaViewManager.vue` and `MetaAutomationRuleEditor.vue` (they may render/validate the value differently; e.g. a chip that assumes a non-null value, or a Zod/JSON schema on re-save).
- **Write-path re-save edge (flag, not fixed here):** because the redacted condition reaches the client with no value, a user who **edits and re-saves** that view could overwrite the saved filter's literal with empty/undefined (they can't see it, so can't preserve it). This is a write-path consequence of read redaction. (b) **must document it**; whether to guard it (e.g. server preserves the original literal on save when the field is denied to the writer) is a **separate follow-up**, not this slice. Read-path redaction must not *silently* corrupt the saved filter.
- **Conclusion:** lock value-only + the omit-value *intent*; the impl PR completes the scan (the two consumers) and finalizes the shape — if a consumer is null/undefined-unstable, the design permits a **redacted-placeholder shape to be finalized by the compat scan** (e.g. a sentinel) rather than committing to omit-value now.

## 5. Test matrix (real-DB integration; fail-first mandatory)

Seed (mirroring #2015/#2044): a sheet the user can read; a view whose `filterInfo` carries a literal on each of — **`FLD_SECRET`** (denied via layer-3, `property.hidden` UNSET), **`FLD_STATIC_HIDDEN`** (layer-2 `property.hidden=true`), **`FLD_VISIBLE`** (readable), **`FLD_VIEWHIDDEN`** (readable but in `hidden_field_ids` = layer-1). The view has a `publicForm` enabled (for the anonymous `GET /form-context` case).

**Non-negotiables:** `FLD_SECRET` denied **solely** via layer-3 (`property.hidden` UNSET — else layer-2 masks it and R1 false-greens); **fail-first** (RED pre-fix, GREEN after); assert against the **whole serialized response body** (the literal must appear nowhere).

| # | endpoint / subject | proves | pre-fix |
|---|---|---|---|
| **R1** (req) | `GET /context` (authed) | the layer-3-denied literal is **absent** from the body; `fieldId`+`operator` for that condition **retained** (chip still renderable) | RED |
| **R2** (req) | `GET /views` (authed) | same — the list path redacts too (the broad-scope parallel-hole guard) | RED |
| **R3** | `GET /view` (authed) | same on the single active-view echo | RED |
| **R4** | `GET /records/:recordId` (authed) | same | RED |
| **R5** (req) | **`GET /form-context` — ANONYMOUS** | **fail-closed**: with no subject, **every** filter literal is absent (incl. the readable ones) — the empty-map-fails-open guard, highest severity | RED (all literals present) |
| **R6** | authed, all primary | a **readable** field's literal is **present** (no over-redaction) | green pre+post |
| **R7** | authed, all primary | a **readable-but-view-hidden** field's literal is **present** (layer-1 ≠ redaction gate; the (a)-R9 analog) | green pre+post |
| **R8** | authed | a **`property.hidden` (layer-2)** field's literal is **absent** — redaction is the layer-2 ∧ layer-3 composite, NOT "layer-3 only" | RED |
| **R9** | a secondary readback (e.g. `PATCH /views/:viewId`) | a `canManageViews`-but-field-denied user's response also redacts the denied literal (field-perm-aware, not gate-dependent) | RED |

R5 pins the anonymous **fail-closed** contract (the worst leak). R7 pins **layer-1 stays** (view-hidden readable literal kept); R8 pins **layer-2 is also redacted** (composite) — together they fence the redaction to exactly layer-2 ∧ layer-3.

## 6. Gated TODO
- ✅ Finding verified + **complete inventory** (10 serialization points incl. `GET /context` + the anonymous `GET /form-context`) + (a)-relationship + the `filterInfo`-value-only-is-the-literal scoping · advisor-checked (caught the anonymous fail-open + the layer-2∧layer-3 precision).
- ✅ Scope locked = broad+ (all view-config serializers) · field-permission-aware shared helper (takes a pre-computed `allowedFieldIds`; **anonymous ⇒ empty ⇒ fail closed**) · **layer-2 ∧ layer-3 composite** (not layer-3-only) · value-only.
- ✅ Design-lock (this doc) — docs-only PR.
- 🔒 **Impl**: shared `redactViewConfigFilterLiterals(view, allowedFieldIds)` helper (or a centralized `serializeViewConfig` — §3 tradeoff) + compute `allowedFieldIds` via the #2015 composite for authed callers / **empty set for anonymous `GET /form-context`** + plumb `fieldScopeMap` into `GET /context` / `GET /views` + apply at all **10** points + R1–R9 fail-first (incl. R5 anonymous fail-closed + R8 layer-2) + **complete the compat scan** (`MetaViewManager`, `MetaAutomationRuleEditor`) to finalize the wire shape + golden-doc note — separate explicit opt-in.
- 🔒 **Write-path re-save guard** (server preserves a denied field's saved literal on re-save) — separate follow-up, flagged §4.1.
- 🔒 full field-def strip (ii) — separate.
