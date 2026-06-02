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
| ⬜ | **D1** `form-context` + form-submit layer-3 (anonymous-form design question — likely intentional) | Design-Q | — | *(decide first)* |
| ⬜ | **kanban / gallery / calendar** view-data egress scan (deferred coverage scan) | Diligence | — | *(scan → maybe add)* |

### Completion
- **By item: 10 / 12 findings closed (≈ 83 %)** — through F5 + its `buildLinkSummaries` review follow-up.
- **By risk: every High + Med + Low leak channel is closed.** Remaining = 1 **design question** (D1, anonymous forms have no subject to scope to) + 1 **coverage scan** (kanban/gallery/calendar). Residual attack surface ≈ retired.

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
- **Forward-defense (proposed, not yet built):** an "egress coverage guard" — a test that enumerates the record-data egress sites and asserts each one routes through `allowedFieldIds`, so a new *ungated* egress fails CI by construction. Tracked as a future hardening item (see §4).
- **Pending re-scan:** the kanban/gallery/calendar view-data scan (matrix §2b, last row).

### Confirmation checklist
- **Per PR (automatic):** CI `test (20.x)` real-DB step green ⇒ all locking tests pass ⇒ no regression. Reviewer confirms any new egress has a locking test.
- **Per release / periodically:** re-run the full real-DB suite; spot-check that the matrix matches `plugin-tests.yml` (every ✅🔒 row's test is still in the list); run the §3-Layer-3 re-scan if new egress endpoints shipped since last check.

---

## 4. Remaining work (each a separate, explicit opt-in)

1. **D1** — decide whether `form-context`/form-submit should apply layer-3 for *identified* (non-anonymous) form callers. Product decision first; likely no code (anonymous submitter has no subject to scope to).
2. **kanban / gallery / calendar scan** (kanban first, then gallery/calendar) — Layer-3 re-scan of these view-data egress paths; add a locking test only if a real ungated egress is found.
3. *(optional hardening)* — build the §3 "egress coverage guard".

---

## 5. How to add / re-confirm a finding (keep this doc the source of truth)
1. Inventory the channel (the #2106 method). 2. Design-lock if a decision is needed. 3. Write the fail-first real-DB test (RED on main → GREEN after fix, + positive control). 4. Implement (reuse the #2015 `allowedFieldIds` composite; never touch the write gate / central RBAC). 5. Wire the test into `plugin-tests.yml`. 6. Verification doc. 7. **Update §2 of this doc** (status · PR · locking test) in the same PR. 8. After merge, the session-memory arc record (`project_multitable_d3_permission_matrix.md`) is updated too.
