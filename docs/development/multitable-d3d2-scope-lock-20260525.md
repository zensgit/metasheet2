# Multitable D3d-2 — Scope Lock (final, 2026-05-25)

Locks D3d-2 scope **before** implementation. This is a standalone artifact (not folded into
the golden matrix) because D3d-2's main value is not "more tests" — it is **pinning the real
permission model** so future reviewers/implementers don't re-litigate it. Predecessor: D3d-1
real-DB golden matrix (#1827, `4ca98cda1`). Source: benchmark v2 §9 #3 / Gap 7.

> Revision note: the scope was narrowed twice during the lock (view-access and sheet both turned
> out to be non-gates). This final version reflects the model **as the code actually behaves**,
> verified against the loaders/routes (§2). No product code is changed.

---

## 0. Systemic finding — the multitable permission model is annotation-rich, enforcement-thin

Verified across four classes: the model is **grant-additive at read**, with **denial only via
field-projection or write-intersection**. The COMPLETE set of real deny-gates:

1. **Field masking** — `field_permissions.visible=false` (export + view-data projection). D3d-1 proven.
2. **Field via member-group** inheritance — mechanically identical (D3d-1 deferred this path).
3. **Sheet write-intersection** — a base-write user holding a read-only sheet row loses write.
4. **Record write-own** — write-own scope + non-creator is blocked.

Everything else — **view-access `canAccess`, sheet-read, record-read** — is a frontend **annotation**
the backend does **not** enforce. A reviewer must NOT flag any of these as a gap or leak:

- **`canAccess=false` does not exist for a reachable user** — GET /view 403s if `!capabilities.canRead`,
  and every `meta_view_permissions.permission` ∈ {read,write,admin} implies `scope.canRead`, so
  `canAccess` is provably **always true**. View-access is annotation-only.
- **"Others have a sheet/record row, so I'm denied read"** is not a semantic — the scope loaders are
  **per-user**; an unmatched user gets no scope → base capability → 200.

If a future change *wants* read-deny or view-access gating, that is a **product model change**
(separate proposal), explicitly out of D3d-2.

---

## 1. Locked scope

Non-admin user (`roles:['member']`); real DB; dedicated CI step; real endpoints. **Read-deny is not
tested** (no such semantic). "result" below = the asserted contract.

### Real deny-gates (asserted)

| case | seed | endpoint | asserted result |
|---|---|---|---|
| **field / inherited-via-member-group** | `field_permissions(member-group, visible=false)` + `platform_member_group_members` | GET export-xlsx | field masked (header + cells) |
| **sheet / inherited** (control) | no sheet row, base `multitable:write` | PATCH /records | **200** |
| **sheet / granted** (control) | matching sheet row `spreadsheet:write` | PATCH /records | **200** |
| **sheet / write-downgraded** (gate) | base `multitable:write` + matching sheet row `spreadsheet:read` only | PATCH /records | **403** (write intersected away) |
| **record / write-own — own** | write-own sheet scope, record `created_by = user` | PATCH /records | **200** |
| **record / write-own — not-own** (gate) | write-own sheet scope, record `created_by = other` | PATCH /records | **403** |

### Non-gates (live assertion for view-access per option (b); documented for reads)

| case | assertion / disposition |
|---|---|
| **view-access** | **one live assertion**: GET /view returns **data** AND `viewPermissions[viewId].canAccess === true` (locks "annotation currently non-blocking" as a test, not just prose — guards against a future implicit 403 or false-leak report) |
| **sheet-read** | documented non-gate: per-user grant-additive, no whitelist deny. No assertion. |
| **record-read** | documented non-gate: grant-only `access_level`, no deny. No assertion. |

## 2. Enforcement reality (verified — so the matrix is honest)

- **field / member-group** → `loadFieldPermissionScopeMap` matches `subject_type='member-group'` via
  `platform_member_group_members`; `deriveFieldPermissions` masks `visible=false`. Export applies it
  (D3c fix). Real.
- **sheet** → `loadSheetPermissionScopeMap` (permission-service.ts:636-699) is **per-user**; unmatched
  user → no scope → `applySheetPermissionScope` returns base capabilities (NOT a deny). With a row,
  `scopedCanWrite = base.canWrite && scope.canWrite`; a read-only row strips write → PATCH base gate
  `if (!capabilities.canEditRecord) sendForbidden` (univer-meta.ts ~6791) → **403**. Read never denied.
- **record write-own** → `deriveRecordRowActions`: under `requiresOwnWriteRowPolicy` (write-own scope),
  `canEdit = canEditRecord && isCreator`. `ensureRecordWriteAllowed` at PATCH/DELETE → non-creator **403**.
- **view-access** → `deriveViewPermissions.canAccess` surfaced only in the response `viewPermissions`
  field (univer-meta.ts ~6098); no `403`/data-block. Annotation.

## 3. Rules (locked)

- **Test/acceptance only.** No `rbac/service.ts` / `auth` / enforcement / model code. Sole non-test
  edit = extending the dedicated CI step.
- **New-leak rule:** only a **real gate failure** stops as RED evidence (separate fix PR, not folded) —
  i.e. `sheet/write-downgraded` or `record/write-own — not-own` returning **200**, or a masked field
  appearing. A **non-gate returning data is the expected contract**, never RED.
- **Read-deny** (sheet / record / view): out of scope; documented as the model's current contract.

## 4. CI + verification

- Extend the existing dedicated `plugin-tests.yml` step (DATABASE_URL hard guard, after `db:migrate`,
  `vitest.integration.config.ts`) to also run the D3d-2 file. Same non-skip discipline + sentinel.
- Verification = real CI "ran N / skipped 0" cited from the dedicated step (no pre-CI pass claims).
- **Output:** consolidated `permission-matrix-golden-20260525.md` merging D3d-1 + D3d-2, **including a
  "model observation: annotation-rich, enforcement-thin" section** (§0 above) so the contract's shape
  is explained, not just listed.

## 5. Out of scope / deferred

- view-data access **gating**, per-record / per-sheet **read-deny** model (product model changes).
- Anything touching central RBAC/auth.
