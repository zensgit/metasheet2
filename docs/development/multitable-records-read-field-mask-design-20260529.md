# Multitable interactive-read field mask (#2015) — design-lock

- **Issue**: #2015 — `GET /records/:recordId` lacks record-scope gate + uses static-only field masking.
- **Status**: design-lock — **approved** (scope B; §2.1 decided = (i) value-only). Landing as a docs-only PR. Implementation is a **separate explicit opt-in** (not in this doc).
- **Date**: 2026-05-29
- **Grounding**: worktree off `origin/main f6987f9eb` (includes #5c-a). Line anchors below verified against that tip.
- **Lock posture**: additive, multitable read-path **kernel-polish** only. RBAC/auth, central permission model, `plugin-integration-core`, and the frozen `src/formula/engine.ts` are **NOT touched**. Permissible under [[k3-poc-stage1-lock]].
- **Framing**: this aligns the code to an **already-declared contract**, not a new product model (see §6). It is **not** a new "product-model proposal" in the sense of the D3 golden §3 open questions.

## 1. The gap (verified, not assumed)

The field-read mask (`field_permissions.visible=false`, the subject-scoped layer-3 read gate) is enforced on the **egress / computed** paths but **not** on the two interactive JSON read paths.

**The masking layers** (`permission-derivation.ts`):
- `isFieldPermissionHidden` (`:64-69`) = **layer-2**, *static* `property.hidden` / `property.visible` only — does **not** consult `field_permissions`.
- `deriveFieldPermissions(...).visible` (`:81-89`) = `!hiddenFieldIds.has(id)` (**layer-1**, `view.hidden_field_ids`) `&& !isFieldPermissionHidden(field)` (**layer-2**) `&& (scope?.visible ?? true)` (**layer-3**, subject `field_permissions` from `fieldScopeMap` — *the real read gate*).
- `filterVisiblePropertyFields` (`:2267-2269`) = layer-2 only.

**Enforced (D3c composite baked into the data):**
- export-xlsx (`univer-meta.ts:5839-5859`) — comment literally: *"export must mirror the view path's field masking — apply subject-scoped `field_permissions` + `view.hidden_field_ids`, **not only static property.hidden**."* Masks data by `visibleFields.filter(fieldPermissions[id]?.visible !== false)`.
- view-aggregate (`:5943-5945`), formula dry-run #5c-a (`:6090-6095`).

**NOT enforced (static-only data mask; full composite shipped only as client metadata):**
- `GET /view` (list, `:6110`) — masks `row.data` by `visiblePropertyFieldIds` = layer-2 (`:6149-6150`, `:6398`); computes the full `fieldPermissions` map *afterwards* (`:6456-6462`) and returns it as `meta.permissions.fieldPermissions` for the client to hide on.
- `GET /records/:recordId` (`:7362`) — same shape: layer-2 data mask (`:7424-7426`); full `fieldPermissions` returned as metadata (`:7450-7453`).

**Consequence (live, reachable):** a user with sheet `canRead=true` but a field denied via `field_permissions.visible=false` (the exact D3d-1 seed) receives that field's **real value** inside `row.data` / `record.data`. The field-read deny is effectively a **client-side-only** control on these paths (trivially read off the network response).

**Why the golden suite didn't catch it (test gap):** every field-denied assertion in the D3 golden suite is on **export-xlsx** (`multitable-permission-golden-d3d1.test.ts`, `multitable-export-permission-canary.test.ts`) or view-aggregate / dry-run. **No test asserts `/view` or `GET /records` `row.data` excludes a field-denied value.** This is the "skip-when-unreachable / wire-vs-fixture" blind-spot class — the gate was proven on the paths it was tested on, and the conclusion "field-mask is a real deny-gate" was generalized.

## 2. Scope (option B — locked)

1. Fix the two interactive read paths: **`GET /view`** and **`GET /records/:recordId`**.
2. Both unify their record-data mask to the **D3c security composite**:
   - layer-2 `property.hidden`
   - layer-3 `field_permissions.visible`
   - `/view` continues to carry its existing **view semantics** (layer-1 `view.hidden_field_ids` stays a *display* concern — see §3.2, **not** newly dropped from data).
3. Do **not** extend to RBAC / auth / `plugin-integration-core`.
4. Two new **real-DB** verifications (§5): `/view` `row.data` no longer contains a field-denied value; `GET /records` likewise.
5. A **compatibility check** (§4): does the frontend rely on "received the denied value but just doesn't display it"? (Done — favorable.)

### Non-goals (explicit)
- **Layer-1 data drop on the interactive reads.** `view.hidden_field_ids` stays display-only on `/view` and `GET /records` (the client toggles column visibility without a round-trip). Export bakes layer-1 in because it is a one-shot egress of a specific view; the interactive feed must not. (Matches #5c-a option B: *layer-3 is the security gate; layer-1 is display.*)
- **Field-definition / field-name stripping** — **DECIDED §2.1 = (i) value-only.** This slice masks **values + summaries** and keeps `fields[]` defs + `fieldPermissions` metadata. Full-strip (ii) is the immediate optional hardening follow-up, **gated on a "missing field definition" compat scan first** (see §2.1).
- **Record-scope gate consolidation on `GET /records`.** The "lacks record-scope gate" half of the #2015 title is, under the current schema, **assessed-inert** (not silently dropped): `record_permissions.access_level` is grant-only (`read|write|admin`, no deny) → record-read is grant-additive (golden §2 record-read non-gate; same finding as #5c-a's T1 reframe). `GET /records` already enforces 404-existence (`:7393`) + 401 (`:7399`) + 403 sheet-`canRead` (`:7402`). Swapping its hand-rolled gate for `requireRecordReadable` would be consistency-only (auto-inherit a *future* record-read-deny level) and would double the existence query (the handler resolves `sheet_id` from the record first). **Optional follow-up, not this slice.** → The live half of #2015 is the field mask; that is what B fixes. **When #2015 is closed, record the record-scope half as assessed-inert** (the issue title names it — don't let it read as forgotten).
- **The other same-class sites** — `POST /patch` write-echo (`:8050`/`:8090`), `GET /form-context` (`:6504`), `POST /views/:viewId/submit` (`:6655`), `GET /records` list (`:7298`), `GET /records-summary` (`:7509`). These mask data by layer-2 too (public-form paths use their own narrower form-field model). They are **deferred same-class candidates**, explicitly **out of this scope** (user scoped B to `/view` + `GET /records`). Listed here so the slice is honest about what it does and does not close.

### 2.1 Decision — value-only mask (locked); full strip deferred

**Decided: (i) value-only.** Recorded with the full reasoning because it is where "align to the declared contract" is genuinely ambiguous and the risk evidence is asymmetric.

**The leak surface still open under the default (value-only):** masking only `record.data`/`rows[].data` + summaries leaves the denied field's **definition** in the returned `fields[]` array — i.e. its **name, type, `select`/`multiSelect` options, and formula/lookup/`property` config** still ship in the response (the client just never renders the column, via `visibleFields`). A field named `Salary` or a formula `{base_pay} * 1.3` is metadata-visible even though its value is masked.

**What "align to contract" literally implies:** golden §0 gate-#1 says the field is **"stripped"**, and export (the only place it is enforced today) strips the field **wholly** — header (name) and cells. A faithful full-strip would drop the denied field from `fields[]` (and reconcile the returned `fieldPermissions`/summaries) on both read paths, matching export exactly.

**Why I did not just pick full-strip:** my §4 compat scan establishes the client does not read denied **values** — it does **not** establish that the client tolerates a **missing field definition** (a view filter/sort rule, a link config, or a formula referencing a now-absent field def). So "value-only is the safe default" is **asymmetrically evidenced**: I verified the risk of value-masking is nil, but I have **not** verified the risk of full-strip. Choosing full-strip would require a second compat pass (does any client path assume every `fieldPermissions` key has a matching `fields[]` entry, or dereference a field def by id without a guard?).

**The two options that were weighed:**
- **(i) Value-only — CHOSEN.** Closes the flagged data leak (the #2015 "static-only field masking"); leaves field *names/config* as inert metadata; smallest blast radius; matches #5c-a (which masked sample values, not defs). Field-name stripping becomes a separate optional hardening.
- **(ii) Full strip (true contract parity) — DEFERRED, gated.** Drop denied fields from `fields[]` + summaries + data, like export. Strongest "align to contract"; closes the name/config metadata leak too; **requires** an extra full-strip compat pass before impl, and adds reconcile work on the returned `fieldPermissions` map.

**Rationale for (i) over (ii) in this slice:** (i) is exactly the flagged leak and is **fully evidenced safe** by §4; (ii)'s residual risk (does the client tolerate a *missing field definition*?) is **not** yet evidenced. So (i) ships the proven fix now, and (ii) is tracked as the **immediate optional hardening follow-up — precondition: a dedicated "missing field definition" compat scan** (does any client path assume every `fieldPermissions` key has a matching `fields[]` entry, or dereference a field def by id without a guard — e.g. view filter/sort rules, link config, formula refs). Only after that scan is clean does (ii) become buildable.

## 3. The fix

### 3.1 Shared mask (the #5c-a precedent, reused verbatim)
The security composite = layer-2 ∧ layer-3, **excluding** layer-1, computed exactly as the shipped dry-run path (`univer-meta.ts:6090-6095`):
```ts
const visibleFields = filterVisiblePropertyFields(fields)                 // layer-2
const fieldScopeMap = access.userId
  ? await loadFieldPermissionScopeMap(query, sheetId, access.userId)
  : new Map()
const securityPerms = deriveFieldPermissions(visibleFields, capabilities, { hiddenFieldIds: [], fieldScopeMap })   // ∧ layer-3 (hiddenFieldIds:[] removes layer-1)
const allowedFieldIds = new Set(
  visibleFields.filter((f) => securityPerms[f.id]?.visible !== false).map((f) => f.id),
)
```
Admin bypass is preserved automatically: `loadFieldPermissionScopeMap` is per-subject; an admin/ungranted-to-deny user gets `scope?.visible ?? true` → field stays. Empty `fieldScopeMap` (no `userId`) is guarded — see §3.2/§3.3.

**Role / member-group masking rides the same primitive.** `loadFieldPermissionScopeMap` already folds role- and `platform_member_group_members`-inherited `field_permissions` into the per-subject scope (golden-proven on export: D3d-1 role, D3d-2 member-group). B inherits that for free — it is **not** re-asserted per path (conscious decision: the deny source is the shared loader, already covered; R1/R2 assert the user-subject channel, which is the same code path).

### 3.2 `GET /view` (`:6110`)
- **Empty-map trap closed by construction (verified).** The handler 401s on `!access.userId` at `:6130-6132` — *before* the `:6398` mask. So `access.userId` is guaranteed truthy at mask time and `loadFieldPermissionScopeMap` always loads a real subject map (parity with `GET /records` `:7399`). The mask must stay after this 401. (Same trap #5c-a closed; here it is already structurally closed.)
- **Load `fieldScopeMap` once, before `:6398`, and reuse** for both the data mask (§3.1) and the returned metadata. Today it is loaded only at `:6456` (*after* the mask) for metadata; the fix moves/shares that single load — do **not** add a second `loadFieldPermissionScopeMap` call (this is the hottest read endpoint).
- Replace the data/summary mask set `visiblePropertyFieldIds` (layer-2) with `allowedFieldIds` (§3.1) at: `row.data` mask (`:6398`), `linkSummaries` filter (`:6411`), `attachmentSummaries` filter (`:6425`).
- **Unchanged:** the returned `meta.permissions.fieldPermissions` (`:6456-6462`) keeps `hiddenFieldIds: viewConfig?.hiddenFieldIds` (full composite incl. layer-1) — this is the client's display signal, and it preserves "/view's existing view semantics." `fields: visiblePropertyFields` (`:6481`) unchanged (see §2.1 — open review decision on field defs).
- Net: a layer-3-denied field's **value** disappears from `rows[].data` and its summaries; a layer-1 (view-hidden) field's value **stays** in data (client hides it via metadata, exactly as today).

### 3.3 `GET /records/:recordId` (`:7362`)
- Compute `allowedFieldIds` (§3.1) and use it for: `record.data` mask (`:7426`), `linkSummaries` (`:7431`), `attachmentSummaries` (`:7444`) — replacing `visiblePropertyFieldIds`.
- **`userId` guard (mandatory, the empty-map trap):** the handler already 401s on `!access.userId` (`:7399-7401`) *before* the mask, so `fieldScopeMap` is always loaded with a real `userId`. Keep that ordering; the mask must sit **after** the 401. (Same trap #5c-a closed with its `if (userId)` wrap.)
- **Unchanged:** returned `fieldPermissions` (`:7450-7453`) keeps layer-1 for display; `fields: visiblePropertyFields` (`:7462`) unchanged.
- Record-gate (404/401/403) unchanged — see §2 non-goal.

### 3.4 Ordering note
On both paths the data is materialized (`applyLookupRollup`) *before* the mask, so a denied lookup/rollup field is also masked out by id. The mask is the **last** transform before serialization on each path — no later step re-introduces a denied value.

## 4. Compatibility check (point 5 — done, favorable)

Scanned `apps/web/src/multitable` for any reliance on receiving denied field **values**:

- **Grid render — SAFE.** `useMultitableGrid.ts:370-376` builds `visibleFields` with the **full** 3-layer filter (`!hiddenFieldIds … && !isPropertyHiddenField … && fieldPermissions[id]?.visible !== false`). `MetaGridTable.vue` renders every `row.data[field.id]` inside `v-for` over `visibleFields`. A layer-3-denied field is **never a column** → its value is never read → dropping it server-side is transparent to the grid.
- **Edit / save — SAFE.** Optimistic edits write per-field (`useMultitableGrid.ts:676/695/720/740`); the drawer→PATCH diff is per-field (`MultitableWorkbench.vue:1534`, `Object.entries(data)` vs loaded record, changed-only); server merge is `changedFieldIds`-based. No reliance on round-tripping denied values. `{...row.data, ...record.data}` refresh-merge (`:796`) is benign (missing key keeps old).
- **Display surfaces that read specific configured fields — change is leak-closing, not a regression.** Other view plugins (Gallery/Kanban/Timeline/Hierarchy, e.g. `MetaKanbanView.vue:297`, `MetaTimelineView.vue:437`) and client conditional-formatting (`utils/conditional-formatting.ts`) read `row.data[configuredFieldId]`. If a view/rule is configured on a field-denied field, **today it leaks** (shows / groups by / styles by the denied value); after B it sees empty. This is a behavior change in the **correct** direction (closes a secondary leak). Note as expected.
- **No global cross-field value iteration / search** over `row.data` that would break (the `Object.keys(...data)` hits are import-parsing and form dirty-check, not denied-grid-field reads).

Conclusion: **B is feasible with no functional regression; the only behavior changes are leak-closing.**

## 5. Test design (real-DB integration; the two required + supporting)

Add to a real-DB integration suite that runs in `plugin-tests.yml` (the DB-hard-guard step; `describeIfDatabase` + a `DATABASE_URL` sentinel test so it fails-not-skips — the same discipline as #5c-a). Namespace seed field IDs to avoid the global-PK collision trap. Seed: a sheet the user can read; `FLD_VISIBLE` (value present), `FLD_SECRET` carrying a `do-not-leak` canary and denied **only** via `field_permissions(subject=user, visible=false)`, and (for the layer-1 control) a view with `FLD_VIEWHIDDEN ∈ hidden_field_ids`.

**The seed is load-bearing — two non-negotiables (this *is* the verification for a security regression):**
1. **`FLD_SECRET.property.hidden` MUST be explicitly UNSET** (and `property.visible` not `false`). If the secret field were also static-hidden, layer-2 (`filterVisiblePropertyFields`) would already mask it on `origin/main`, the test would pass **before** the fix, and R1/R2 would exercise nothing — the exact false-green this design exists to prevent. The deny MUST come solely from layer-3.
2. **Demonstrate fail-first.** R1/R2 must be shown **RED on `origin/main f6987f9eb` (pre-fix)** and **GREEN after** the mask change. The impl/verification PR records both states (e.g. the pre-fix red run/diff). A canary-absent assertion that was never red proves nothing.

| Test | Path | Proves |
|---|---|---|
| **R1 (required)** | `GET /view` | `rows[].data` **omits** `FLD_SECRET` (no canary anywhere in the response body); `fieldPermissions[FLD_SECRET].visible===false` still returned (metadata intact). Closes the documented test gap. |
| **R2 (required)** | `GET /records/:recordId` | `record.data` **omits** `FLD_SECRET`; canary absent from body; metadata intact. |
| R3 | both | `FLD_VISIBLE` value **present** (mask doesn't over-strip). |
| R4 | both | **layer-1 unchanged**: a `view.hidden_field_ids` field's value **stays** in data (display-only; not security-dropped) — pins the §2 non-goal. |
| R5 | both | **admin / ungranted-to-deny** user: `FLD_SECRET` value **present** (per-subject grant-additive; mask doesn't deny the wrong user). |
| R6 | `GET /view` | link/attachment **summaries** for a denied field are omitted (mask covers summaries, not just `data`). |
| R7 | both | unauth → 401 (mask never runs on empty `fieldScopeMap`). |

The canary assertion must scan the **whole serialized response body** (not just `data[FLD_SECRET]`) so a value re-surfacing via a summary or nested field is caught.

## 6. Framing — align to declared contract, not a new model

The D3 golden doc (`permission-matrix-golden-20260525.md`) §0 lists **"Field masking — `field_permissions.visible=false` → field stripped from export + view projection"** as REAL deny-gate **#1**, *distinct* from the §2 non-gates (view-access, sheet-read, record-read) and the §3 open product-model questions (per-record read-deny, view-access data gating). Field-read masking is **already claimed as enforced**. B makes the interactive read paths actually honor that claim. It is therefore a **code↔contract reconciliation**, not a §3-style product proposal.

**Golden-doc reconciliation (small, post-merge or in the impl PR):** §0 gate-#1's evidence column cites D3d-1, whose assertions are export-only. After B lands with R1/R2, the golden doc should note that field-masking is now also asserted on `/view` + `GET /records` `row.data` (not only export). Recorded here so the doc-vs-evidence gap is closed honestly; the doc edit is **not** a model change.

## 7. Gated TODO

- ✅ Finding verified (code + golden doc + test-absence + primitive defs) · advisor-checked ×2 · compat-scanned · `/view` 401-before-mask verified (`:6130`).
- ✅ **§2.1 decided = (i) value-only.**
- ✅ **Design-lock approved (scope B + §2.1=(i)) — landing as docs-only PR.**
- 🔒 **Impl** (`/view` + `GET /records` value+summary mask swap + R1–R7, **fail-first demonstrated**, single shared `fieldScopeMap` load) — separate explicit opt-in.
- 🔒 **Golden-doc reconciliation** — with or right after impl.
- 🔒 **(ii) full field-strip hardening** — optional follow-up; **precondition = "missing field definition" compat scan** (§2.1), then its own opt-in.
- 🔒 Deferred same-class (`POST /patch` echo, form paths, `GET /records` list, `/records-summary`) · record-gate consolidation — separate, not started.
