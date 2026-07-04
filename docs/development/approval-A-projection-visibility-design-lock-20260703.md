# A — T3-6 approval projection base visibility hardening · DESIGN-LOCK + as-built (2026-07-03)

> Arc-A of the line-completion. Closes the leak flagged in the T3-6 closeout: the projection base
> (`base_apr_projection`) materializes approval outcomes but has no per-sheet share, so it fell to the standard
> multitable capability gate — and `deriveCapabilities` grants `canRead` to **any** holder of global
> `multitable:read`. **Owner-default decision: admin-only.** Per-row `visibility_scope` inheritance is a
> separate, later slice.

## Decision
The approval projection base is **admin-only readable**. A non-admin — even with global `multitable:read` —
is denied read/export/write on the base, its sheets, and its records, and it does not appear in their base or
sheet listings. Admins (and the reserved system owner, which the routes treat as admin-equivalent) are
unaffected. **Fail-closed**, keyed strictly on `APPROVAL_PROJECTION_BASE_ID` — every other base is
byte-identical.

## Choke points (why they cover every content-read path)
Grounded the multitable read-authorization flow; content read funnels through three shared resolvers, now
each gated (admins bypass, so the extra lookup never touches the admin hot path):
1. **`resolveSheetCapabilities`** (`permission-service.ts`) — the single-sheet + record read choke (record
   read goes through `resolveSheetReadableCapabilities` → this). Applies the full non-admin capability fence
   (see Mechanism) on a projection sheet.
2. **`filterReadableSheetRowsForAccess`** (`permission-service.ts`) — the shared sheet-listing gate used by
   the base list + 3 sheet-list routes. Filters projection sheets out for non-admins; since a base surfaces
   in the base list only if it has ≥1 readable sheet, this also **hides the projection base itself**.
3. **`resolveReadableSheetIds`** (`permission-service.ts`) — a second listing path; filters projection sheets.
4. **`resolveSheetCapabilitiesForUser`** (`sheet-capabilities.ts`) — **review P1 correction**: this resolver is
   NOT REST-only; it fronts the **collab sheet-room auth** (`index.ts:2289`), **Yjs record auth**
   (`index.ts:2370`), and **api-token capability** (`routes/api-tokens.ts:141`) read paths. An earlier claim
   that it had "no callers" was wrong — a non-admin with global `multitable:read` would have gotten
   `canRead:true` on a projection sheet via collab/Yjs. Now gated with the same guard + query shape; locked by
   a resolver-level unit test (non-admin `multitable:read` → `canRead:false`; ordinary sheet + admin →
   `canRead:true`; non-admin writer → all write/manage caps `false`), RED-before confirmed.

## Mechanism
- **`approval-projection-constants.ts`** (new, **import-side-effect-free**): the single source of truth for
  `APPROVAL_PROJECTION_BASE_ID` + `isApprovalProjectionBaseId` + the pure
  `restrictApprovalProjectionCapabilities`. The projection service re-exports the id from here — so the id is
  reachable from the permission hot path **without** dragging the service's `eventBus`/scheduler subscription
  surface into it (the concern that must not be imported into permission resolution).
- **Full capability fence** (**review P1 #2 correction**): the guard originally downgraded only
  `canRead`/`canExport` (its `canWrite`/`canWriteOwn` keys don't exist on `MultitableCapabilities`, so they
  were no-ops) — a non-admin holding `multitable:write`/workflow perms kept `canEditRecord`/`canDeleteRecord`/
  `canManageViews`/`canManageAutomation`/… on the projection sheet, and write paths gate on exactly those.
  `restrictApprovalProjectionCapabilities` now denies **every sensitive capability boolean** for a non-admin on
  a projection sheet: `canRead`, `canExport`, `canCreateRecord`, `canEditRecord`, `canDeleteRecord`,
  `canManageFields`, `canManageSheetAccess`, `canManageViews`, `canComment`, `canManageAutomation`,
  `canSendNotification`. Admin capabilities are untouched.
- **`loadApprovalProjectionSheetIds(query, sheetIds)`**: one lightweight `SELECT id FROM meta_sheets WHERE
  id = ANY($1) AND base_id = $2` — only invoked for **non-admins** (admins bypass), so no admin-path cost.

## Verification (fail-first, real-DB)
`approval-projection-visibility.db.test.ts` — **7/7**: the projection-sheet lookup identifies projection vs
ordinary sheets; a non-admin (`multitable:read`) is **denied** single sheet/record read while the SAME
non-admin **can** read an ordinary sheet; an **admin can** read the projection sheet; a non-admin **writer**
(`multitable:write` + `workflow:write`) has **all** read/write/manage caps `false` on the projection sheet
while keeping `canEditRecord`/`canDeleteRecord`/`canManageAutomation` on an ordinary sheet; listing filters the
projection sheet for a non-admin (→ base absent from base list) and keeps it for admin; `resolveReadableSheetIds`
excludes it. `approval-projection-capabilities-for-user.test.ts` — **4/4** (the collab/Yjs/api-token resolver:
reader denied / ordinary allowed / admin allowed / writer fully fenced). **RED-before confirmed** twice:
neutralizing `loadApprovalProjectionSheetIds` → 4 tests fail (the read leak returns across all chokes);
reverting the fence to read-only downgrade → the writer tests fail (the write leak returns). `tsc` 0.
**T3-6 write/reconcile regression** `approval-record-projection` 14/14 (the constant re-export is inert to the
write path). **Full unit + integration suites** — the gated resolvers added a DB lookup that mock-pool
tests had to answer (test-drift swept across 10 integration mock-pools + 3 unit button-route builders +
`yjs-hardening`'s resolver mock: a projection-sheet lookup on a non-projection sheet returns empty).

## Out of scope (explicit follow-ups)
- **Per-row `visibility_scope` inheritance** (each projected row inheriting the source approval's visibility) —
  a separate slice; this rung is base-level admin-only.
- The projection base's **write path** is unchanged (system-owned; T3-6 reconcile untouched).
