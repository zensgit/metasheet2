# Multitable D3d-2 — Scope Lock (2026-05-25)

Locks the scope of D3d-2 **before** implementation, and records one semantic correction to
the original D3d design that must not be re-litigated as a bug. Predecessor: D3d-1 real-DB
golden matrix (#1827, `4ca98cda1`). Source: benchmark v2 §9 #3 / Gap 7.

This is a deliberate **standalone** artifact (not folded into the final golden matrix) because
D3d-2 is not a routine test split — it corrects a permission **semantic**: `meta_view_permissions`
"denied" does **not** block data; it only flips a response annotation.

---

## 0. The correction a reviewer must not flag as a bug

Original D3d design (§2) listed `view` as a permission **class** with granted/denied/inherited,
implying access enforcement. **In the current product, view-access is annotation-only:**

- `deriveViewPermissions(...).canAccess` is surfaced in the GET /view response `viewPermissions`
  field. There is **no** `if (!canAccess) return 403` and **no** record/data filtering on it.
- So a user with `meta_view_permissions` granting no read still **receives the view data**, with
  `viewPermissions[viewId].canAccess === false` as advisory metadata for the frontend.

**Therefore:** "`canAccess=false` but data still returned" is **correct current behavior**, NOT a
D3d-2 gap and NOT an enforcement bug. D3d-2 asserts the **annotation contract**, not a data gate.
(This parallels the record-read finding: grant-only model, no server-side read-deny.)

If a reviewer believes view data *should* be blocked when `canAccess=false`, that is a **product
model change** (separate proposal), explicitly out of D3d-2 scope.

**Second non-gate (corrected during scope-lock):** `spreadsheet_permissions` is **per-user
grant-additive, not a whitelist read-gate** (verified in `loadSheetPermissionScopeMap`). A user with
**no** sheet row still reads via base capability (200) — "others have a sheet row, so I'm denied read"
is **not** a semantic. So a reviewer must NOT flag "ungranted user still reads the sheet" as a gap. The
real sheet gate is the **write intersection** (§1/§2 below). The original lock's "sheet read 200/403"
assumption was wrong (not a code bug); this commit corrects it.

---

## 1. Locked scope — what D3d-2 tests, and how

Non-admin user (`roles:['member']`) so scoping applies. Real DB, dedicated CI step, asserted
through real endpoints.

| case | enforcement reality | assertion (the contract) | endpoint |
|---|---|---|---|
| **view-access / granted** | annotation only | `viewPermissions[viewId].canAccess === true` | GET /view |
| **view-access / denied** | annotation only (data NOT blocked) | `canAccess === false` **AND data still returned** (documents non-gate) | GET /view |
| **view-access / inherited** | annotation only | no `meta_view_permissions` row → `canAccess === true` (from sheet/base capability) | GET /view |
| **sheet / inherited** | **real gate (write axis)** | no sheet row + base `multitable:write` → PATCH **200** (base capability passes) | PATCH /records |
| **sheet / granted** | **real gate (write axis)** | matching sheet row `spreadsheet:write` + base write context → PATCH **200** | PATCH /records |
| **sheet / write-downgraded** | **real gate (write axis)** | base `multitable:write` + matching sheet row `spreadsheet:read` only → write intersected away → PATCH **403** | PATCH /records |
| **sheet / read-denied** | **N/A** | no "others have a sheet row so I'm denied read" semantic — `loadSheetPermissionScopeMap` is per-user grant-additive; unmatched user → no scope → base capability → 200. Read-deny = no base capability (sheet-independent). | — |
| **record / write-guard** | **real guard** | granted → 200; no grant + not creator → **403** | PATCH/DELETE /records |
| **record / read** | grant-only, **no deny exists** | N/A — documented, not tested as bug | — |
| **field / inherited-via-member-group** | real (completes D3d-1 deferred path) | field masked in export via `platform_member_group_members` | GET export-xlsx |

## 2. Enforcement reality (verified, so the matrix is honest)

- **view-access** → `permission-derivation.ts deriveViewPermissions` (canAccess) consumed only as
  response metadata in `univer-meta.ts` (e.g. ~3409/6098/7076); no gate. **Annotation contract.**
- **sheet** → `loadSheetPermissionScopeMap` (permission-service.ts:636-699) fetches **only the
  requesting user's** rows (user / role-membership / member-group). **Unmatched user → no scope →
  `applySheetPermissionScope` returns base capabilities unchanged** (NOT a deny). So spreadsheet_permissions
  is **per-user grant-additive, not a whitelist read-gate**. The real gate is the **write
  intersection**: when the user *has* a sheet row, `scopedCanWrite = base.canWrite && scope.canWrite`,
  so a base-write user holding a read-only sheet row loses write → PATCH/DELETE **403**. Every perm_code
  implies read, so `scopedCanRead` is never false for a row-holder → **read is never sheet-denied**.
  **Corrected from the original lock's read-gate assumption** (that assumption was wrong, not an
  enforcement bug — verified against the loader, no code change).
- **record write/delete** → `ensureRecordWriteAllowed` enforced at PATCH/DELETE (univer-meta.ts
  ~6531/7342/7459) → 403. **Real guard.** Record *read* has no deny (grant-only `access_level`).

## 3. Rules (locked)

- **Test/acceptance only.** No `rbac/service.ts` / `auth` / enforcement / model changes. Sole
  non-test edit = extending the dedicated CI step.
- **New-leak rule:** if any assertion reveals a *new* enforcement leak (a real gate failing), the
  suite **stops as RED evidence**; the fix goes in a **separate** PR, NOT folded into D3d-2.
- **Read-deny** (record or view): out of scope; documented as open model question.

## 4. CI + verification

- Extend the existing dedicated `plugin-tests.yml` step (DATABASE_URL hard guard, after
  `db:migrate`, `vitest.integration.config.ts`) to also run the D3d-2 file — or add a sibling
  dedicated step. Same non-skip discipline.
- Verification = real CI "ran N / skipped 0" cited from the dedicated step (no pre-CI pass claims).
- **Output:** consolidated `permission-matrix-golden-20260525.md` merging D3d-1 + D3d-2 evidence.

## 5. Out of scope / deferred

- view-data access **gating** (would require a product model change).
- per-record **read-deny** model.
- Anything touching central RBAC/auth.
