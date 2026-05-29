# Multitable read-path search/filter/sort field mask (priority-#2 (a)) — design-lock

- **Slice**: priority-#2 **(a)** — the search/sort/filter field-**selection** half of the #2015 deferred same-class set. The field-read gate (`field_permissions.visible`) is enforced on returned **data** (#2015 / #2028) and on aggregate **output** (#1840), but the **filter / search / sort field selection** on the interactive read paths still runs on the static **layer-2** set, so a denied field can still be searched-by-value, filtered-on, or sorted-by.
- **Status**: 🔒 design-lock (this doc). Docs-only PR. Implementation is a **separate explicit opt-in** (not in this doc).
- **Date**: 2026-05-29
- **Grounding**: read-only worktree off `origin/main 6841389bb`; every anchor below was opened and verified at that tip.
- **Lock posture**: additive multitable read-path **kernel-polish**. RBAC/auth, central permission model, `plugin-integration-core`, and the frozen `src/formula/engine.ts` are **NOT touched**. Permissible under [[k3-poc-stage1-lock]].
- **Framing**: code↔contract reconciliation, **not** a new product model. The field-read gate is already the declared contract (D3 golden gate #1); this makes it hold on *all* read-path field selection, not only on data egress. Direct lineage of #2015/#2024 (the same "proven on the path it was tested on, generalized" blind-spot class).
- **Scope sibling**: this is **(a)**. The related **(b)** — `viewConfig.filterInfo` raw-literal redaction in the response — is a **separate** design (the *literal-in-payload* channel; this slice is the *behavioral* channel). See §6.

## 1. The gap (verified, anchored)

The masking layers (`permission-derivation.ts`): layer-1 `view.hidden_field_ids` (display) · layer-2 static `property.hidden` · **layer-3 subject `field_permissions.visible` = the real read gate**.

**Enforced (layer-3):** `/view` row data + summaries (#2015, `:6161` `allowedFieldIds`), `GET /records/:recordId` (#2028), export-xlsx (#1820), view-aggregate **output** (#1840, `:5944-5946`).

**NOT enforced — filter/search/sort field selection still keys off layer-2** (`visiblePropertyFields` / `fieldTypeById` / `searchableFieldIds`):

| endpoint | facet | anchor | field set |
|---|---|---|---|
| `GET /view` | **search — SQL fast-path** (`hasSimpleSearchFastPath`, `:6205`) | `searchableFieldIds` (`:6165`) → `buildRecordSearchPredicateSql` (`:6217`) | layer-2 |
| `GET /view` | **search — in-memory path** (search **+** filter/sort) | `recordMatchesSearch(record, visiblePropertyFields, search)` (`:6304`) | layer-2 |
| `GET /view` | **filter** (saved `viewConfig.filterInfo`) | `fieldTypeById.has` (`:6178` returned, `:6308` applied) | layer-2 |
| `GET /view` | **sort** (saved `viewConfig.sortInfo`) | `fieldTypeById` (`:6173` validated, `:6325` applied) | layer-2 |
| `GET …/view-aggregate` | **search** | `recordMatchesSearch(rec, visibleFields, search)` (`:5957`) | layer-2 |
| `GET …/view-aggregate` | **filter** (saved `view.filterInfo`) | `filterFieldTypeById.has` (`:5959`) | layer-2 |

> ⚠️ **`/view` has TWO search code paths with different field-set variables.** The SQL fast-path fires only when `hasSearch && !hasFilterOrSort` (`:6205`); search *combined with* a filter/sort falls to the in-memory path (`:6304`), which uses a **different** variable (`visiblePropertyFields`, not `searchableFieldIds`). **Both must be fixed**, and the trap is that a naive `?search=<secret>` test exercises only the fast-path (no filter/sort) and goes green while search+filter still probes the denied field — the exact lineage blind-spot. The test matrix (§7) triggers **both** branches.

**Consequence (live):** a user with sheet `canRead=true` and a field denied via `field_permissions.visible=false` (the D3d-1 seed) can still:
- `?search=<denied value>` → server-side `ILIKE` / in-memory match over the denied field → **direct value-probe oracle**;
- have a saved view's filter on the denied field **narrow the row set** by its values → **inclusion/exclusion oracle** (and on view-aggregate, **move the COUNT/SUM**);
- have a saved view's sort on the denied field **order rows** by its values → **relative-order leak**.

The denied field's *values* never appear in the payload (#2015 masks data; #1840 omits its aggregate) — the leak is **behavioral** (which rows / what order / what count), not literal.

## 2. The parity invariant — why /view and view-aggregate must be fixed together (decisive)

view-aggregate documents a **deliberate** decision (`:5926-5929`): *"FILTER/SEARCH field set MIRRORS /view (static-visible only, NOT D3c-filtered) so the filtered SET is identical to /view … filtering on a hidden field still counts the rows (matches /view) but never outputs that field's aggregate (no leak)."*

Two things follow:
1. **The "no leak" rationale is incomplete.** It reasons only about the denied field's *own* aggregate output. But the *row set itself* is an oracle: `?search=<denied value>` changes which rows match → changes the COUNT and every *other* field's SUM/aggregate over the matched set. The leak is independent of which field's aggregate is output. This comment must be **revised** as part of the fix.
2. **The two endpoints maintain a `filtered-set parity` invariant** (`/view` rows ⇔ view-aggregate's aggregated row set). #2015 deliberately left `/view`'s filter/search set at layer-2 (it tightened only *data*), preserving this parity. If (a) tightens `/view`'s filter/search to layer-3 but **not** view-aggregate, the invariant breaks — the same field-read gate would be a real gate on one read path and a half-gate on the parallel one, and the two would return divergent sets. **So combined scope is required for correctness, not just hygiene.**

## 3. Severity framing (primary → weakest)

- **Primary — search.** `search` is **arbitrary request input** on *both* endpoints (`/view :6115`, view-aggregate `:5895` `normalizeSearchTerm(req.query.search)`). A caller crafts `?search=<guess>` and reads match/count → the most directly exploitable probe.
- **Secondary — saved-view filter.** Only bites when a **saved** view has a condition on a denied field (situational). Row-set inclusion/exclusion oracle; on view-aggregate, moves the aggregate. **Shares its root with (b)** ("a saved view references a denied field") — (a) is the *behavioral* manifestation, (b) the *literal-in-payload* one.
- **Weakest — saved-view sort.** `/view` only; orders rows by the denied field → relative-order leak; values still masked.

## 4. The fix (locked approach)

Intersect the filter/search/sort field **selection** with a **layer-3-ONLY allowed set** — `deriveFieldPermissions(<static-visible fields>, capabilities, { hiddenFieldIds: [], fieldScopeMap }).visible !== false`. ⚠️ **`hiddenFieldIds: []` is load-bearing**: the selection gate must be **layer-3 only** so layer-1 (`view.hidden_field_ids`) stays *display-only* and the `/view`↔aggregate parity (§2) holds. `/view` already has exactly this set as `allowedFieldIds` (`:6161`, from #2015). **view-aggregate does NOT have a reusable one** — its `:5944-5946` set is derived with `hiddenFieldIds: viewHiddenFieldIds` (layer-1 ∧ layer-3) and exists for *output omission*; it must **not** be reused for selection (see the per-endpoint note). A denied field is then treated like an **unavailable field** (excluded from search/filter/sort), exactly as a non-existent field already is.

- **`/view`** — derive `searchableFieldIds` (`:6165`) from `allowedFieldIds` not `visiblePropertyFields`; pass the layer-3 field subset to the in-memory `recordMatchesSearch` (`:6304`); validate sort rules (`:6173`/`:6325`) and filter conditions (`:6178`/`:6308`) against `allowedFieldIds` instead of `fieldTypeById`. **Both search paths (fast-path + in-memory) must change.**
- **`/view-aggregate`** — derive a **separate layer-3-only selection set** (`deriveFieldPermissions(visibleFields, capabilities, { hiddenFieldIds: [], fieldScopeMap })`, mirroring `/view`'s `allowedFieldIds`) and gate search (`:5957`) + filter (`:5959`) by it. **Do NOT reuse the `:5944-5946` output set** — it bakes in layer-1 (`hiddenFieldIds: viewHiddenFieldIds`, `:5930`), so using it for *selection* would make a **readable-but-view-hidden** field unsearchable/unfilterable on view-aggregate while it stays searchable on `/view` (whose `allowedFieldIds` is layer-3-only) → **breaks the §2 parity invariant**. Keep `:5944-5946` for its existing job (**output omission**, which correctly *does* drop view-hidden + denied aggregates). Revise the `:5926-5929` comment to state the filter/search **selection** is now layer-3-only on **both** endpoints (layer-1 stays display-only; parity preserved at the security boundary).

### 4.1 Dropped-condition semantic (explicit)
Dropping a denied filter/sort condition **broadens / reorders** the result relative to what the saved view intended (the narrowing/ordering is gone). This is **correct, not a regression**: a filter/sort on a field the user cannot read cannot be honored, and it is the *same disposition* the code already applies to a non-existent field — minus the misleading warning (§4.2). State this in the impl PR so "the saved view now returns more rows" is not misread.

### 4.2 Warning design decision (locked)
A denied field excluded from sort/filter must **NOT** be folded into the existing `ignoredSortFieldIds` / `ignoredFilterFieldIds` "字段不存在 / field doesn't exist" bucket (`:6185-6189`): the copy would be **misleading** (the field exists; the user just can't read it), and it would add a redundant existence signal. **Silently exclude** denied fields (the client already knows denials from the returned `fieldPermissions` metadata). Whether to surface a *distinct* "no-permission ignored" channel is a deliberate **non-goal** here (could be a later UX opt-in); default = silent.

### 4.3 Two filter representations — gate at the derivation, not a single use-site
On `/view` the saved filter exists as **two** shapes: the **applied** conditions (in-memory at `:6308`) and the **returned computed echo** `filterInfo`/`computedFilterSort` (derived at `:6178`/`:6181`, sent in `meta` for the client to render). Gate the **selection at the derivation (`:6178`)** with `allowedFieldIds` so the denied condition is dropped from **both** the applied filter and the returned computed echo — patching only `:6308` would still echo the denied condition in `computedFilterSort` (same trap shape as the two search paths). Note: the **raw** `view: viewConfig.filterInfo` echo (the verbatim saved config) is a **different** object and is deliberately **left untouched here** — that literal channel is **(b)**, not (a). So (a) drops the denied condition from the *computed/applied* filter; (b) will later redact it from the *raw* echo.

## 5. Out of scope / non-goals (explicit)
- **(b) `viewConfig.filterInfo` raw-literal redaction** — the response returns `view: viewConfig` with raw `filterInfo` (incl. `MetaFilterCondition.value`); a saved condition on a denied field leaks that *literal* in the payload. **Separate design** (the literal channel; this slice is the behavioral channel). Cross-referenced, not fixed here.
- **full-strip (ii)** — dropping denied field *definitions* from `fields[]`; gated behind a "missing field definition" compat scan (#2015 §2.1).
- **Other layer-2-only read sites** — `POST /patch` echo, `GET /form-context`, `POST /views/:viewId/submit`, `GET /records` list, `/records-summary`. Deferred same-class.
- **Computed-filter on view-aggregate** — lookup/rollup/formula filter conditions already hard-fail 422 (`:5938-5939`); unchanged.
- **RBAC/auth/integration-core/`engine.ts`** — untouched (K3 lock).

## 6. Test matrix (real-DB integration; fail-first mandatory)

Add to the `plugin-tests.yml` real-DB step (DATABASE_URL hard-guard; `describeIfDatabase` + sentinel). Seed (mirroring #2015/#2028): a sheet the user can read; `FLD_VISIBLE`; `FLD_SECRET` carrying a `do-not-leak` canary value, denied **only** via `field_permissions(subject=user, visible=false)`; and (for R9) `FLD_VIEWHIDDEN` — **no** `field_permissions` deny (layer-3 visible) but present in the test view's `hidden_field_ids` (layer-1 hidden).

**Seed non-negotiables (the security regression's proof):**
1. **`FLD_SECRET.property.hidden` MUST be UNSET** — deny solely via layer-3 (else layer-2 already excludes it and the test false-greens pre-fix).
2. **Fail-first** — each row demonstrated RED on `origin/main` (pre-fix) and GREEN after.
3. **The search canary value must exist ONLY in `FLD_SECRET`** (no row carries it in a layer-3-visible field) — else that row still matches search post-fix via the visible field and R1/R2's "row excluded" assertion confounds/false-reds. Pair with a **visible-field positive control**: a *different* term present in `FLD_VISIBLE` that still matches post-fix → proves "denied field not searched," not "search broken."
4. **R5/R6 need a real aggregation config + a non-zero positive control** (e.g. `COUNT(*)` or `SUM(FLD_VISIBLE)` over a seed where the denied-filter-matched subset is non-empty): assert the no-denied-filter aggregate equals a specific **non-zero** expected value, then assert the with-denied-search/filter aggregate **equals it**. Otherwise "unchanged" is satisfied vacuously by empty==empty and proves nothing post-fix (the #2015 R6 vacuous-pass trap).

| # | endpoint / path | proves | pre-fix |
|---|---|---|---|
| **R1** | `GET /view?search=<canary>` — **SQL fast-path** (no filter/sort) | a denied field is NOT searchable: the matching row is **not** returned (and canary absent) | RED (row matched) |
| **R2** | `GET /view?search=<canary>` **+ a benign saved filter/sort** — **in-memory path** | the *other* `/view` search path is also gated (the §1 two-path trap) | RED |
| **R3** | `GET /view` with a **saved view filtering on `FLD_SECRET`** | the denied filter condition is **dropped** → row set not narrowed by the denied value (and the run is not tagged "field doesn't exist") | RED (rows narrowed by denied value) |
| **R4** | `GET /view` with a **saved view sorting on `FLD_SECRET`** | the denied sort rule is dropped → order not determined by the denied field | RED (order leaks) |
| **R5** | `GET …/view-aggregate?search=<canary>` | the **aggregate result is unchanged** whether or not the search references the denied field (assert COUNT/SUM equality, NOT "value absent" — the oracle is the aggregate itself) | RED (count/agg moves) |
| **R6** | `GET …/view-aggregate` with a saved denied-field filter | aggregate result unchanged vs no-filter (denied filter dropped) | RED |
| **R7** | **parity** | under a saved denied-field filter, `/view` row **count** == view-aggregate **count** (pins the `:5926-5929` invariant being rewritten) | — (assert agreement) |
| **R8** | non-over-restriction | `FLD_VISIBLE` IS searchable/filterable/sortable; an **ungranted-to-deny** user CAN search/filter `FLD_SECRET` (per-subject) | green pre+post |
| **R9** | **layer-1 ≠ selection gate** (the parity regression guard) | a **readable-but-view-hidden** field (`FLD_VIEWHIDDEN`: no `field_permissions` deny, present in the view's `hidden_field_ids`) stays **searchable + filterable on BOTH `/view` and view-aggregate**, and their counts **agree** — layer-1 is display-only, not a selection gate. **RED if impl wrongly gates view-aggregate selection by the `:5944-5946` output set** (which bakes in layer-1) → the field would drop on aggregate but not `/view`. | green pre+post (guards the layer-3-only-selection requirement) |

R5's assertion shape differs deliberately from R1-R4 (advisor): on view-aggregate the oracle is the aggregate **output** moving, so assert result equality, not value-absence.

## 7. Gated TODO
- ✅ Finding verified + anchored (both endpoints, both `/view` search paths, the parity invariant + the `:5926-5929` comment) · advisor-checked.
- ✅ Scope locked = `/view` (search+filter+sort) + `/view-aggregate` (search+filter); combined scope **required** by the parity invariant.
- ✅ Design-lock (this doc) — docs-only PR.
- 🔒 **Impl** (intersect filter/search/sort selection with layer-3 on both endpoints — **both `/view` search paths** — + revise the `:5926-5929` comment + R1–R8 fail-first + golden-doc note) — separate explicit opt-in.
- 🔒 **(b)** `viewConfig.filterInfo` literal redaction — separate design, after (a).
- 🔒 full-strip (ii) · other layer-2 read sites — separate, not started.
