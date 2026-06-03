# Multitable field-read-gate — goal & living tracker

**Date:** 2026-06-02 · **Status:** LIVING DOC (update on every merge into the arc).
**Origin:** the #2106 egress inventory (`multitable-record-egress-fieldperm-inventory-20260529.md`).

This is the single source of truth for the multitable **field-read-gate** security arc: the goal, what is done vs pending, the **test that locks each item**, and **how we keep confirming it**. Markers: ✅ done · ⬜ pending · 🔒 locked-by-a-CI-test.

---

## 1. Goal (the invariant)

> **Every channel that egresses record cell data applies the field-read gate of the requesting subject** — layer-2 (`property.hidden`) **∧** layer-3 (`field_permissions.visible`), via the #2015 composite `deriveFieldPermissions(...).visible !== false` → `allowedFieldIds` → `filterRecordDataByFieldIds` — **plus** sheet-level `canRead`/`canManageViews` authorization where the endpoint lacked it. A field a subject cannot read must never appear in any response, echo, or broadcast, regardless of how the subject reached it (read, write-back, create, computed, related-record, or realtime).

The write gate is **not** changed by this arc (a field can be writable yet read-denied — "write-only-no-read"); only the **read/echo/broadcast** surfaces are gated.

**Out of scope (K3 Stage-1 lock):** central RBAC/auth, `plugin-integration-core`, new record-level read-deny semantics, full field-definition strip.

---

## 2. Coverage matrix (status · severity · PR · locking test)

The **locking test** is the real-DB integration test wired into `.github/workflows/plugin-tests.yml` ("multitable real-DB integration" step). Each asserts a denied-field **canary is absent** from the channel; if a future change drops the mask, that test goes **RED** and blocks the PR. That is the enforcement — see §3.

### 2a. Foundational read masks (the floor)

| ✅ | Channel | Sev | PR | Locking test |
|---|---|---|---|---|
| ✅🔒 | `GET /view` + `GET /records/:recordId` data mask | High | #2028 | `multitable-records-read-field-mask` |
| ✅🔒 | search / filter / sort **selection** gate | High | #2044 | `multitable-readpath-search-filter-field-mask` |
| ✅🔒 | `viewConfig.filterInfo` literal echo redaction | Med | #2059 | `multitable-viewconfig-filter-literal-redaction` |
| ✅🔒 | view-config **re-save guard** (write-back of redacted filters) | Med | #2074 | `multitable-viewconfig-resave-guard` |
| ✅ | redacted-filter editor UX | (frontend) | #2084 | `multitable-view-manager.spec` (web) |
| ✅🔒 | view-aggregate hidden-field omit | Med | #1840 | `multitable-view-aggregate` |

### 2b. #2106 findings + the two new findings

| ✅ | Finding | Sev | PR(s) | Locking test |
|---|---|---|---|---|
| ✅🔒 | **F0a** `GET /records` (cursor list) authz + mask | **High** (broken access) | #2114 | `multitable-records-list-authz` |
| ✅🔒 | **F0b** dashboard/charts per-sheet authz | **High** | #2125 design · #2141 impl | `multitable-dashboard-chart-authz` |
| ✅🔒 | **F1** record history (`snapshot`/`patch`) mask | Med-High | #2148 | `multitable-record-history-field-mask` |
| ✅🔒 | **F2** records-summary `displayFieldId` gate | Med | #2157 | `multitable-records-summary-field-mask` |
| ✅🔒 | **F3** write-echo mask (PATCH + POST /patch) | Med | #2169 | `multitable-write-echo-field-mask` |
| ✅🔒 | **crossSheetRelated** echo mask (new finding) | Med | #2176 design · #2178 impl | `multitable-cross-sheet-related-echo-mask` |
| ✅🔒 | **realtime** broadcast: D0 `join-sheet` authz + D1 value-free invalidation (new finding) | **High** (no-auth room) | #2181 design · #2183 impl | `multitable-sheet-realtime.api` + `rooms.basic` |
| ✅🔒 | **F4** `POST /records` create-echo mask | Low-Med | #2186 | `multitable-create-echo-field-mask` |
| ✅🔒 | **F5** `loadRecordSummaries` display: `link-options` `data.records` + `people-search` `items` (foreign/people default-display value) | Low | #2198 | `multitable-summary-display-field-mask` |
| ✅🔒 | **linkSummaries** (`buildLinkSummaries`) foreign default-display value across `GET /view` · single-record read · link-options `data.selected` · write-echo (review follow-up to F5) | Med | #2198 | `multitable-link-summary-display-field-mask` |
| ✅🔒 | **D1** `form-context` (recordId load) + `POST /views/:id/submit` echo layer-3 mask — **identified-path leak (NOT no-op)**; anonymous moot (no subject) | Med | #2210 | `multitable-form-context-submit-field-mask` |
| ✅ | **kanban / gallery / calendar** view-data egress scan — **scan-clean, no live egress** (standalone view plugins are dead-sample/unreachable; product reuses the gated `/view`) | Diligence | #2206 | *scan-clean — no test (no live egress); see scan doc + §3 latent-risk note* |

### Completion
- **By item: 12 / 12 findings closed (100 %) — ARC COMPLETE.** 11 **CI-locked masks** (each with a real-DB locking test) + 1 **scan-clean** (kanban/gallery/calendar view-data: scanned, **no live egress found → no locking test**, see scan doc). The scan-clean item is a *coverage conclusion*, not a CI-enforced mask — its continued validity rests on §3 Layer-3 (the latent-risk re-scan trigger), not a test.
- **By risk: every High + Med + Low leak channel is closed.** D1 turned out to be a **real identified-path layer-3 leak** (not the presumed no-op) — fixed + locked. Anonymous form callers remain correctly out of layer-3 (no subject to scope to). Residual attack surface ≈ retired.
- **Open follow-ups are optional hardening only** (§4): the §3 egress-coverage **change gate** is BUILT and the dead sample view plugins are **deleted**; the only remaining item is the deferred 2nd-stage `AllowedFieldIds` branded type. None is an open leak.

---

## 3. Continuous confirmation — how this stays true

Three layers; the doc is the **index**, CI is the **lock**.

### Layer 1 — Automated regression (already enforcing, every PR)
Every ✅🔒 row above has a real-DB test in the `plugin-tests.yml` "multitable real-DB integration" step, asserting the **denied-field canary is absent** from that channel. That step runs on **every PR** (CI `test (20.x)`), against a freshly-migrated Postgres, with a `DATABASE_URL` hard-guard + a sentinel so it **fails-not-skips**. ⇒ if any future refactor drops a mask or an authz gate, its locking test turns **RED and blocks merge**. **No closed item can silently regress.**

### Layer 2 — New-slice discipline (the definition of done)
A finding is only ticked ✅🔒 here when **all** of:
1. design-lock doc (if the fix needs a design decision) — `docs/development/*-design-*.md`;
2. **fail-first** real-DB test: proven **RED on unmodified `origin/main`** (canary present), **GREEN after the fix** (canary absent), with a **positive control** so an empty response can't false-pass;
3. the test is **wired into `plugin-tests.yml`** (Layer 1);
4. a verification doc — `docs/development/*-verification-*.md`;
5. **this matrix updated** in the same merge (status, PR, locking test).

### Layer 3 — New-surface detection (the gap to watch)
Layers 1–2 protect *known* channels. A *new* record-data egress endpoint could reintroduce the leak class. To confirm continuously:
- **Trigger:** whenever a new endpoint returns record cell values (new read, echo, summary, export, broadcast), **re-run the #2106 egress inventory method** (grep every `res.json`/`filterRecordDataByFieldIds`/`loadRecordSummaries`/`buildLinkSummaries`/`linkSummaries`/raw `data[fieldId]` egress; classify gated vs ungated).
  - **Lesson (the `buildLinkSummaries` follow-up):** a cell value can leak even when it is *not* a direct `data[fieldId]` egress — `buildLinkSummaries` reads a *foreign* sheet's display field into a computed `display`, and the `filter*FieldSummaryMap` wrappers only drop unreadable *link fields* (caller-side), never the foreign display *value*. So the grep set must include **derived/summary display values keyed to another sheet**, masked by *that* sheet's `allowedFieldIds` (per-sheet keying), not just first-class `data[fieldId]` writes.
- **Forward-defense (BUILT 2026-06-02):** the **egress-coverage guard** — `tests/unit/multitable-egress-coverage-guard.test.ts` (plain unit test, always-on in the core-backend test step, no DB). It snapshots every record-data egress/mask helper call-site across `src/` (count per file × helper) vs a checked-in GOLDEN; a new/removed egress turns it **RED** with the file:line + the directive (route through `allowedFieldIds` + add a real-DB locking test + update §2 + GOLDEN). **It is a CHANGE GATE, not a gating proof:** it forces *review* of any egress-surface change but does NOT verify the set is actually layer-2∧3 (by-value — only the per-channel real-DB locking tests prove that), and it only tracks the known egress helpers (a handler shipping raw `record.data` without them stays on the manual re-scan Trigger above). The compile-time `AllowedFieldIds` branded type *would* verify gating — **deferred** to its own design-lock + refactor PR (§4), not folded in (it would touch ~30 mask call-sites in the security-critical `univer-meta.ts`/`record-write-service.ts`). Verification: `multitable-egress-coverage-guard-verification-20260602.md`.
- **Done re-scan:** the kanban/gallery/calendar view-data scan — **scan-clean** (2026-06-02, `multitable-view-data-egress-scan-20260602.md`): no live egress; the standalone view plugins are dead-sample (sample-kanban's `records` table doesn't exist; gallery/calendar forward to an **unhandled** `spreadsheet:records:query` event) and unreachable (gallery/calendar have no manifest), and the product renders these view-types client-side off the gated `/view`.
  - **Lesson (sample-plugin latent egress):** "scan-clean" on a *dead* path is NOT "no egress code exists." The gallery/calendar samples ship fully-formed `/records` + `/records/:recordId` egress routes with **no authz and no field mask** — inert only because nothing wires them. **Adding a manifest, wiring a `spreadsheet:records:query` handler, or creating the bare `records` table re-arms them → any such change MUST re-enter this egress inventory and route record data through the target sheet's `allowedFieldIds` before shipping.** (Same shape as F0b latent-not-live.)

### Confirmation checklist
- **Per PR (automatic):** CI `test (20.x)` real-DB step green ⇒ all locking tests pass ⇒ no regression. Reviewer confirms any new egress has a locking test.
- **Per release / periodically:** re-run the full real-DB suite; spot-check that the matrix matches `plugin-tests.yml` (every ✅🔒 row's test is still in the list); run the §3-Layer-3 re-scan if new egress endpoints shipped since last check.

---

## 4. Remaining work (optional hardening only — the arc's leak findings are all closed)

The 12 findings are closed (§2). What remains is **non-leak hardening**, each a separate explicit opt-in:

1. ✅ *(done 2026-06-02)* — the **egress-coverage change gate** (`tests/unit/multitable-egress-coverage-guard.test.ts`) — see §3 Layer-3. Snapshots the record-data egress surface; any new/removed egress fails the always-on unit test until reviewed + GOLDEN-updated. Change gate, **not** a gating proof (gating is still proven by the per-channel real-DB locking tests).
2. ✅ *(done 2026-06-03)* — **deleted the 3 dead sample view plugins** (`plugins/plugin-view-kanban` / `plugin-view-gallery` / `plugin-view-calendar`) + their 3 dormant, CI-excluded plugin-loader fixture tests (`kanban-plugin` / `kanban.mvp.api` / `plugins-api.contract`) — removes the latent ungated `/api/kanban/:id` + gallery/calendar `/records` egress routes outright. Re-verified dead first: gallery/calendar have no manifest (unloadable); kanban queries a non-existent `records` table; no live gallery/calendar ViewConfigProvider in `src`; the boards `packages/core-backend/plugins/plugin-view-kanban` is a **different, kept** config plugin. `validate:plugins` 12/12 valid · egress guard green · tsc 0. Verification: `multitable-dead-sample-plugin-deletion-verification-20260603.md`. (Residual mentions remain only in **frozen historical archive docs** — past-tense records, intentionally not rewritten.)
3. *(deferred 2nd-stage hardening)* — **`AllowedFieldIds` branded type**: make the egress masks accept only a layer-3-composite-produced branded set, so passing a layer-2-only set is a *compile error* (verifies gating, which the change gate can't). Its own design-lock + `tsc`-guided refactor PR (~30 mask call-sites in `univer-meta.ts`/`record-write-service.ts`) + full field-read-gate real-DB suite — **do NOT fold into other egress work**. Trigger: a future large egress/mask refactor, or the change gate catching repeated same-class risk.

> **D1 closed** (#2210): the presumed no-op turned out to be a **real identified-path layer-3 leak** on `form-context` (recordId load) + `POST /views/:id/submit` echo — masked by layer-1∧2 only, leaking a denied field's value to an authenticated caller (anonymous moot). Fixed with the #2015 composite + locking test `multitable-form-context-submit-field-mask`. Design: `multitable-form-context-submit-field-mask-design-20260602.md`.

---

## 5. How to add / re-confirm a finding (keep this doc the source of truth)
1. Inventory the channel (the #2106 method). 2. Design-lock if a decision is needed. 3. Write the fail-first real-DB test (RED on main → GREEN after fix, + positive control). 4. Implement (reuse the #2015 `allowedFieldIds` composite; never touch the write gate / central RBAC). 5. Wire the test into `plugin-tests.yml`. 6. Verification doc. 7. **Update §2 of this doc** (status · PR · locking test) in the same PR. 8. After merge, the session-memory arc record (`project_multitable_d3_permission_matrix.md`) is updated too.
