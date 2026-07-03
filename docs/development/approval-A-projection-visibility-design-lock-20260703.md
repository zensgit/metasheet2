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
   read goes through `resolveSheetReadableCapabilities` → this). Downgrades caps to `canRead:false` for a
   non-admin on a projection sheet.
2. **`filterReadableSheetRowsForAccess`** (`permission-service.ts`) — the shared sheet-listing gate used by
   the base list + 3 sheet-list routes. Filters projection sheets out for non-admins; since a base surfaces
   in the base list only if it has ≥1 readable sheet, this also **hides the projection base itself**.
3. **`resolveReadableSheetIds`** (`permission-service.ts`) — a second listing path; filters projection sheets.

`resolveSheetCapabilitiesForUser` (`sheet-capabilities.ts`) has **no callers** on any read path (verified) →
no gate needed.

## Mechanism
- **`approval-projection-constants.ts`** (new, **import-side-effect-free**): the single source of truth for
  `APPROVAL_PROJECTION_BASE_ID` + `isApprovalProjectionBaseId` + the pure
  `restrictApprovalProjectionCapabilities`. The projection service re-exports the id from here — so the id is
  reachable from the permission hot path **without** dragging the service's `eventBus`/scheduler subscription
  surface into it (the concern that must not be imported into permission resolution).
- **`loadApprovalProjectionSheetIds(query, sheetIds)`**: one lightweight `SELECT id FROM meta_sheets WHERE
  id = ANY($1) AND base_id = $2` — only invoked for **non-admins** (admins bypass), so no admin-path cost.

## Verification (fail-first, real-DB)
`approval-projection-visibility.db.test.ts` — **6/6**: the projection-sheet lookup identifies projection vs
ordinary sheets; a non-admin (`multitable:read`) is **denied** single sheet/record read while the SAME
non-admin **can** read an ordinary sheet; an **admin can** read the projection sheet; listing filters the
projection sheet for a non-admin (→ base absent from base list) and keeps it for admin; `resolveReadableSheetIds`
excludes it. **RED-before confirmed**: neutralizing `loadApprovalProjectionSheetIds` → 4 tests fail (the leak
returns across all chokes). `tsc` 0. **T3-6 write/reconcile regression** `approval-record-projection` 14/14
(the constant re-export is inert to the write path). **Full unit suite 4169/4169** — the gated resolvers added
a DB lookup that three mock-pool button-route builders had to answer (test-drift fixed: a projection-sheet
lookup on a non-projection sheet returns empty).

## Out of scope (explicit follow-ups)
- **Per-row `visibility_scope` inheritance** (each projected row inheriting the source approval's visibility) —
  a separate slice; this rung is base-level admin-only.
- The projection base's **write path** is unchanged (system-owned; T3-6 reconcile untouched).
