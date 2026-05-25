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
| 1 | **Field masking** | `field_permissions.visible=false` → field stripped from export + view projection | D3d-1 (#1827) |
| 2 | **Field via member-group** | same, via `platform_member_group_members` membership | D3d-2 |
| 3 | **Sheet write-intersection** | base `multitable:write` + read-only sheet row → `scopedCanWrite=false` → PATCH 403 | D3d-2 |
| 4 | **Record write-own** | write-own sheet scope + non-creator → PATCH 403 | D3d-2 |

Everything else is annotation/grant-additive (non-gates, §2).

## 1. Golden matrix — real gates (asserted, real DB)

| class | state | endpoint | contract | source |
|---|---|---|---|---|
| field | granted (user visible=true) | export-xlsx | field present | D3d-1 |
| field | denied (user visible=false) | export-xlsx | field absent (header+cells) | D3d-1 |
| field | inherited-via-role (role visible=false) | export-xlsx | field absent | D3d-1 |
| field | inherited-via-member-group (group visible=false) | export-xlsx | field absent | D3d-2 |
| view-projection | granted / denied (`view.hidden_field_ids`) | export-xlsx | present / absent | D3d-1 |
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
  non-gate — _<CI evidence filled in the D3d-2 verification MD §4.2>_.
- Both run via the dedicated `plugin-tests.yml` step (DATABASE_URL hard guard); non-skip proven in CI.
