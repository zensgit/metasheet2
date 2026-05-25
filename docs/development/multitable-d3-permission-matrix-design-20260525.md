# Multitable D3 — Permission Matrix Golden Gate: Design + Canary (D3a, 2026-05-25)

Design for benchmark v2 §9 #3 / Gap 7 (`docs/development/multitable-feishu-benchmark-20260522.md:223`).
Follows the D2 perf-gate discipline: **measure (here: test) before fixing**, with a hard
boundary against the central RBAC/auth surface.

Predecessor: D2 perf gate closed at PR #1815 (B excluded → no virtualization → effort
redirected here, per the v2 sequencing).

---

## 0. TL;DR

- **D3 = a 5-class permission golden matrix** (role × {sheet/view/field/record/export} ×
  {granted/denied/inherited}), asserted **black-box against the real wire**, not a
  build-new-permissions slice. The machinery already exists and is backend-enforced.
- **Export is the highest-risk canary, and a scout + code read found it likely leaks**
  (3 confirmed gaps — §3). The earlier "leak already closed" reading was wrong: export
  masks only *static* `property.hidden`, not subject-scoped `field_permissions`, and
  applies neither record-level read filtering nor view-hidden filtering.
- **Discipline (this is the key constraint):** the canary tests run first. If they go
  red (confirm the leak), **failing tests are NOT merged to main** — a small, scoped
  enforcement-fix PR (export projection in `univer-meta.ts` only, **never** `rbac/service.ts`)
  lands first; then the full golden suite + acceptance MD land green.

---

## 1. Scope & boundary

The permission system is mature and **backend-enforced** (not frontend-only), layered on
top of a **central RBAC module shared beyond multitable**. The boundary, by zone:

| zone | surface | status |
|---|---|---|
| 🟢 golden test suite (black-box) | assert real endpoints (`GET /records`, `GET /export-xlsx`, PATCH/DELETE guards) | **in-bounds** — test-only, multitable kernel-polish |
| 🟡 multitable enforcement fix | `permission-service.ts` / `univer-meta.ts` export projection | **separate gated opt-in** (D3c below) — backend code, scoped to export only |
| 🔴 central RBAC / auth | `packages/core-backend/src/rbac/service.ts`, `auth/permission-templates.ts` | **DO NOT TOUCH** — shared with K3/integration; would risk the K3 stage-1 lock |

## 2. Existing surface (from scout)

| class | backend enforcement | frontend | existing tests |
|---|---|---|---|
| Sheet | `permission-service.ts:281-362` `resolveSheetCapabilities` / `applySheetPermissionScope` | `MetaSheetPermissionManager.vue` | `multitable-permission-service.test.ts` |
| View | `permission-service.ts:701-772` `loadViewPermissionScopeMap`; `deriveViewPermissions` | same | `multitable-workbench-permission-wiring.spec.ts` |
| Field | `permission-service.ts:774-828` `loadFieldPermissionScopeMap`; `deriveFieldPermissions` (applies `fieldScopeMap`) | `types.ts:325 MetaFieldPermissionEntry` | `permission-derivation.test.ts`, `multitable-scoped-permissions.spec.ts` |
| Record | `permission-service.ts:830-886` `loadRecordPermissionScopeMap`; `ensureRecordWriteAllowed` | `useMultitableRecordPermissions.ts` | `multitable-record-permissions-composable.spec.ts` |
| Export | `univer-meta.ts:5663 GET /sheets/:sheetId/export-xlsx` | `MetaToolbar.vue:148` | `multitable-xlsx-routes.test.ts` (**property.hidden only**) |

**D3 is a consolidation + completeness pass**, not greenfield — the gap is "no unified
5-class golden matrix" and the export canary.

## 3. Export canary — confirmed gaps (the corrected security framing)

Read of `univer-meta.ts:5663-5710` + `permission-derivation.ts:62-90`:

1. **Field — subject-scoped leak (High).** Export @5689 calls `filterVisiblePropertyFields`,
   which filters via `isFieldPermissionHidden()` = **static `property.hidden` / `property.visible`
   only**. The subject-scoped path (`deriveFieldPermissions` with a `fieldScopeMap`,
   `visible: baseVisible && (scope?.visible ?? true)`) is **never invoked** — export builds no
   field scope map. A field hidden by `field_permissions.visible=false` for a role/user/group
   **is exported** (header + cell values).
2. **Record — read filtering absent (High).** Export pages `queryRecordsWithCursor` and writes
   **every** returned record (@5695); it never calls `loadRecordPermissionScopeMap` /
   `deriveRecordPermissions` (which the view path applies @~6051). Records the user cannot read
   in the grid are exported.
3. **View — hidden/permission ignored (Medium).** @5676 validates only view existence + sheet
   match. Exported fields come from `loadFieldsForSheetShared` (all sheet-visible fields), not
   `view.hidden_field_ids`; no `deriveViewPermissions`. View-hidden fields leak via export.

Verified: the export route (5663-5730) invokes **none** of the scope-map loaders or `derive*`
permission functions.

## 4. Golden matrix shape

Each class × subject-state, as a reproducible table with explicit expected outcome:

```
class    ∈ {sheet, view, field, record, export}
role/subject ∈ {user, role, member-group}
state    ∈ {granted, denied, inherited}
```

For each cell: a black-box assertion through the real endpoint. Export rows assert **both
header and cell values** omit masked fields/records (the leak surface).

**Row #1 (the canary keystone, written first):**
> User has sheet `read` + `export` capability, but field `F` is hidden via
> `field_permissions.visible=false` (subject-scoped, not `property.hidden`).
> `GET /sheets/:id/export-xlsx` response **must not** contain `F` in the header row **nor**
> in any cell. (Current `multitable-xlsx-routes.test.ts` covers only `property.hidden`, so this
> case is unguarded today and is expected to go RED.)

Plus rows for: export of record the user can't read (record-scope denied); export with `viewId`
whose `hidden_field_ids` includes `F`.

## 5. Test harness approach

- **Black-box integration tests** (extend `packages/core-backend/tests/integration/`), hitting
  the **real route + real query/export projection** against a test DB — *not* hand-built
  fixtures. (Per the wire-vs-fixture-drift lesson: a unit test against a fabricated field list
  would pass while the real wire leaks.)
- Seed `field_permissions` / `record_permissions` / `meta_view_permissions` rows directly, then
  assert the endpoint output.
- Tri-state (granted/denied/inherited) parametrized per class.

## 6. Slicing + the canary discipline (locked)

| slice | content | merge rule |
|---|---|---|
| **D3a** (this doc) | design + golden matrix shape + canary spec | docs-only → **mergeable** |
| **D3b** | write the export canary tests (field/record/view) + run | if RED → **do NOT merge to main**; park on branch |
| **D3c** (conditional) | enforcement fix — **`univer-meta.ts` export projection ONLY** (load field/record scope maps + view-hidden, mirror the view path); never `rbac/service.ts`/`auth` | gated opt-in; lands first to make canary green |
| **D3d** | full 5-class golden suite + acceptance MD (`permission-matrix-golden-*.md`) | lands green after canary passes |

**Hard rules:** no failing tests on main; enforcement fix scoped to export projection only;
central RBAC/auth untouched; each slice a separate explicit opt-in.

## 7. Out of scope / next links

- New permission *features* (row-level rule engine, sharing links) — not D3.
- Cross-base (benchmark #8) — gated behind D3 stable + K3/integration GATE PASS.
- Frontend permission UX polish — separate.

Next opt-in after this design review: **D3b** (write the export canary tests).
