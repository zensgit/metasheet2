# Multitable Permission Matrix — Golden Contract (2026-05-25)

The consolidated permission contract for multitable, backed by real-DB integration tests
(D3d-1 #1827 + D3d-2 this PR). Benchmark v2 §9 #3 / Gap 7. This document is the **single source
of truth** for "what the permission model actually enforces" — read §0 before proposing any
permission change or filing a "leak" report.

---

## 0. Model observation — annotation-rich, enforcement-thin

The multitable permission model is **grant-additive at read, with denial only via field-projection
or write-intersection.** This was verified class-by-class against the loaders/routes (not assumed).
Knowing this prevents re-litigating the same phantoms:

- **Read is never denied by per-object permissions.** Sheet/record/view scope loaders are *per-user*
  and *additive*; an unmatched user falls through to base capability (200). "Someone else has a row,
  so I'm denied" is **not** a semantic anywhere.
- **`access_level`/`permission` enums are grant-only** (`read`/`write`/`admin`) — no `deny`/`none`.
- **Frontend annotations are not gates.** `viewPermissions.canAccess`, record `rowActions`, etc. are
  advisory metadata; the backend does not block data on them. `canAccess` *does* reflect the view-wide
  whitelist (it can be `false` for an ungranted user when the view has assignments), but GET /view never
  403s on it — data is returned regardless. The contract is "not enforced", not "constant value".

### The complete set of REAL deny-gates

| # | gate | mechanism | proven by |
|---|---|---|---|
| 1 | **Field masking** | `field_permissions.visible=false` → field value stripped from export **and** the interactive `/view` / `GET /records/:recordId` reads (+ view-aggregate, formula dry-run) | D3d-1 (#1827, export) · #2015 (#2024 design / interactive reads) |
| 2 | **Field via member-group** | same, via `platform_member_group_members` membership | D3d-2 |
| 3 | **Sheet write-intersection** | base `multitable:write` + read-only sheet row → `scopedCanWrite=false` → PATCH 403 | D3d-2 |
| 4 | **Record write-own** | write-own sheet scope + non-creator → PATCH 403 | D3d-2 |

Everything else is annotation/grant-additive (non-gates, §2).

> **#2015 reconciliation (2026-05-29, not a model change).** Gate #1 was originally evidenced on **export only** (D3d-1); the interactive read paths masked `row.data`/`record.data` by **static layer-2 (`property.hidden`)** alone and shipped a `field_permissions`-denied value inside the JSON payload, relying on the client to hide it from the returned `fieldPermissions` metadata (a client-side-only control — the documented "skip-when-unreachable / wire-vs-fixture" blind spot: the gate was proven on the path it was tested on and the conclusion generalized). #2015 (#2024 design-lock, scope B / value-only) made `/view` + `GET /records/:recordId` honor the subject-scoped layer-3 gate at the wire, asserted real-DB in `multitable-records-read-field-mask.test.ts` (R1/R2, fail-first). **Layer-1 (`view.hidden_field_ids`) stays display-only on the interactive reads** (value present, hidden via metadata — R4), unlike export which bakes it in; that asymmetry is intentional (one-shot egress vs. interactive feed). Field-**definition** stripping (name/type/config) is deferred (value-only), gated on a missing-field-def compat scan.

> **priority-#2 (a) — search/filter/sort SELECTION (2026-05-29, impl of design #2038).** Beyond returned data/aggregate-output, the field-read gate now also governs **field selection**: a `field_permissions`-denied field is excluded from `?search=` (both `/view` SQL fast-path + in-memory, and `view-aggregate`) and from saved-view **filter/sort** conditions (dropped like a non-existent field — **silently**, no "field doesn't exist" warning), on `GET /view` and `GET .../view-aggregate`. Selection is gated by a **layer-3-ONLY** set (`hiddenFieldIds: []`) so layer-1 (`view.hidden_field_ids`) stays display-only — a readable-but-view-hidden field remains searchable/filterable (R9), and view-aggregate's layer-1∧layer-3 *output* set is **not** reused for selection (it would break `/view`↔aggregate parity). Real-DB R1–R9 fail-first in `multitable-readpath-search-filter-field-mask.test.ts`. Closes the arbitrary-`?search=` value-probe + the saved-view filter/sort row-set oracles; the raw `view: viewConfig.filterInfo` **literal** echo (channel (b)) is a separate follow-up.

> **priority-#2 (b) — view-config filter-LITERAL redaction (2026-05-29, impl of design #2052).** The raw `view: viewConfig.filterInfo` echo carried `conditions[].value` (the saved comparison **literal**) verbatim. Now a shared **pure, field-permission-aware** helper (`redactViewConfigFilterLiterals`) **omits the `value`** of any condition on a field the **requester** can't read (layer-2 ∧ layer-3 composite; `fieldId`+`operator` kept), at **all 7 view-config echoes** — `GET /context`, `GET /views`, `GET /view`, `GET /records`, `POST/PATCH /views`, and `GET /form-context`. Three fail-open vectors fenced: **anonymous `/form-context`** (empty allowed-set ⇒ fail-closed, all literals redacted); **authed base-only `/context?baseId=`** (`allowedFieldIds` bound to `effectiveSheetId`, not the null `resolvedSheetId`); **layer-2 `property.hidden`** literals also redacted (composite). Helper is **pure** (returns a copy — view configs are cached; a cross-user test pins no shared-object corruption). Layer-1 view-hidden-but-readable literals stay. Form-share endpoints return `serializePublicFormShareConfig` (no `filterInfo`) → not leak vectors. Real-DB R1–R9 fail-first in `multitable-viewconfig-filter-literal-redaction.test.ts`. The field-read gate now covers data (#2015/#2028) + aggregate output (#1840) + selection (#2044) + the filter-literal echo (this). Write-path re-save guard (re-saving a redacted view nulls the literal) = separate follow-up.

## 1. Golden matrix — real gates (asserted, real DB)

| class | state | endpoint | contract | source |
|---|---|---|---|---|
| field | granted (user visible=true) | export-xlsx | field present | D3d-1 |
| field | denied (user visible=false) | export-xlsx | field absent (header+cells) | D3d-1 |
| field | inherited-via-role (role visible=false) | export-xlsx | field absent | D3d-1 |
| field | inherited-via-member-group (group visible=false) | export-xlsx | field absent | D3d-2 |
| field | denied (user visible=false) | `GET /view` (`rows[].data`; link summaries — attachment summaries ride the identical `allowedFieldIds` set) | value absent (canary never on the wire) | #2015 (R1 data; R6 link summary) |
| field | denied (user visible=false) | `GET /records/:recordId` (`record.data`) | value absent | #2015 (R2) |
| field | denied (user visible=false) | `GET /view` / `GET /records` | **ungranted-to-deny** user still sees the value (per-subject; mask doesn't deny the wrong user) | #2015 (R5) |
| view-projection | granted / denied (`view.hidden_field_ids`) | export-xlsx | present / absent | D3d-1 |
| view-projection | `view.hidden_field_ids` | `GET /view` / `GET /records` | value **present** in data, hidden via `fieldPermissions` metadata (layer-1 = display-only on interactive reads, unlike export) | #2015 (R4) |
| sheet | inherited (no row, base write) | PATCH /records | 200 | D3d-2 |
| sheet | granted (`spreadsheet:write`) | PATCH /records | 200 | D3d-2 |
| sheet | **write-downgraded** (`spreadsheet:read` only) | PATCH /records | **403** | D3d-2 |
| record | write-own — own | PATCH /records | 200 | D3d-2 |
| record | write-own — not-own | PATCH /records | **403** | D3d-2 |
| export | capability | export-xlsx | no `multitable:read` → 403 (`canExport` fused to `canRead`) | D3d-1 |

## 2. Golden matrix — non-gates (the contract, by design)

| class | disposition | how locked |
|---|---|---|
| **view-access** (`canAccess`) | whitelist annotation, NOT enforced — `canAccess` can be `false` (view has assignments, user ungranted) yet data is never blocked | **live assertion** (D3d-2): `canAccess===false` AND rows returned |
| **sheet-read** | per-user grant-additive; unmatched user reads via base capability | documented (no deny path exists) |
| **record-read** | grant-only `access_level`; no deny | documented (D3d-1 + D3d-2) |

## 3. Open model questions (out of scope — would be product changes)

- Per-record / per-sheet **read-deny** (whitelist or deny `access_level`).
- **View-access data gating** (block view data when `canAccess=false`).

These are NOT bugs or test gaps; they are absences in the current model. Any future work adding them
is a deliberate product-model proposal, not a "fix."

## 4. Evidence

- **D3d-1** (#1827, `4ca98cda1`): export+field tri-state + view projection — **7 passed / 0 skipped**,
  real DB (run 26403388718).
- **D3d-2** (this PR): member-group field + sheet write-intersection + record write-own + view-access
  non-gate — **15 passed / 0 skipped** (combined with D3d-1), real DB (run 26408342198).
- Both run via the dedicated `plugin-tests.yml` step (DATABASE_URL hard guard); non-skip proven in CI.
