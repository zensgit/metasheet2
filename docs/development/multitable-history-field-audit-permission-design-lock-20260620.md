# Multitable History — Field-Audit Permission (DESIGN-LOCK)

> Status: **DESIGN-LOCK — RATIFIED 2026-06-20 (decisions D1–D7 resolved; locks L1–L8). docs-only.**
> Runtime is GATED: first allowed slice = A1 (grant model + contract, no reveal); each later slice is a
> separate opt-in.
> Origin: follow-up flagged when #2968 closed the global-history LOCK-3 field leak by masking
> `field_permissions`-hidden fields for everyone, **including admins** (parity with the per-record history
> route). Owner ratified "field-permissions do NOT bypass for admin" as status quo, and asked to design admin
> full-field history audit as a **separate audit-permission** rather than by flipping that mask.
> Related: `multitable-global-history-pit-restore-design-lock-20260619.md` (LOCK-3 field layer),
> `multitable-global-history-mvp-dev-verification-20260619.md` §0 (the #2968 fix).

## 1. Problem

After #2968, both history surfaces (global `GET /bases/:baseId/history/events[/:batchId]` and per-record
`GET /sheets/:id/records/:id/history`) mask any field a viewer cannot read via `field_permissions` — its id,
value, and count are all dropped — and this mask applies to admins too. That is correct as the default.

A legitimate compliance / security investigation sometimes needs the masked truth: *"who changed the Salary
field, and to what, between these dates."* The unsafe way to enable that is to let admins bypass the field
mask — that is not a separate control, it is admin bypass with extra steps, and it leaves restricted field
values one role-flip away. This design adds full-field history visibility as a **separate, governed,
explicitly-triggered, self-audited break-glass capability** that admin alone does not confer.

## 2. Positioning

Depth, not scale: a **break-glass that is closed by default even for its holders**. The power to see
restricted history is never implied by being an admin; it is granted by a higher authority, time-boxed,
scoped, exercised by an explicit per-use action, and recorded both when granted and every time used — so
lifting the field mask is always an accountable, deliberate act, never a silent standing privilege.

## 3. Locks (load-bearing invariants)

- **LOCK-1 — Separate governed grant, never admin-implicit.** A *History Field-Audit grant* (a row in
  `meta_history_audit_grants`, subject × base) is the ONLY thing that can lift the history field mask. Holding
  `admin`, `multitable:admin`, the row-deny admin bypass, base-admin, sheet-owner, or row-admin does NOT
  confer it. Absent a valid grant, behaviour is byte-for-byte the #2968 mask.
- **LOCK-2 — Grant authority, separation of duties, issuance audited, no self-widening.** Issuing/revoking a
  grant requires a dedicated platform capability **`multitable:history-field-audit:grant`**, held only by
  platform/org security governance (platform admin / org owner / org security admin). base-admin, sheet-owner,
  row-admin can NOT issue. Hard sub-locks: (a) issuer ≠ grantee (no self-granting); (b) the issuing capability
  is strictly above base-admin; (c) every grant issue AND revoke writes an audit record (issuer, grantee,
  scope, expiry, time); (d) a grantee can NOT widen their own grant (scope/expiry are fixed by the issuer; a
  grantee never holds `:grant` and cannot re-issue or extend).
- **LOCK-3 — Fail-closed, inert by default.** No valid grant → today's field mask, unchanged. Capability/
  feature-flag off → byte-inert. Any resolution edge (missing/expired/out-of-scope grant, unknown subject,
  resolver error) → mask, never reveal.
- **LOCK-4 — Field axis only; never lifts the row axis; read-only.** Reveal lifts the FIELD mask ONLY, and
  only on records the auditor can ALREADY row-read. It does NOT lift row-level read-deny (a row-denied record
  stays invisible and uncounted even for an auditor) and confers no write of any kind. Audit is orthogonal to
  the row axis.
- **LOCK-5 — The reveal is audited; the trail is NOT a second home for values (hard).** Every reveal writes an
  `operation_audit_logs` record via `AuditService`, carrying ONLY: actor, base/sheet, batch/record scope, the
  revealed field IDs, the reason (L8), and time. It stores **no field values** — the audit trail must never
  become a second, weaker-protected copy of restricted data. (Non-negotiable; a future tier that ever persists
  values would inherit the strictest field protection — out of scope here.)
- **LOCK-6 — One reveal resolver across both history surfaces.** Global history (the #2968
  `buildHistoryAllowedFieldsBySheet`) and per-record history (`loadAllowedFieldIds` →
  `redactRecordRevisionEntry`) both consult a single `resolveHistoryFieldAuditReveal(subject, base/sheet,
  revealRequested)`. The grant, the reveal gate, and the logging are shared, not duplicated — divergence would
  itself be a hole.
- **LOCK-7 — Reveal never composes with any write/restore path.** A reveal affects history READ DISPLAY only.
  The audit-revealed field set is NEVER fed into the writable/affected field set of any write, restore-preview,
  or PIT-restore. Those paths compute their field sets from the actor's NORMAL (masked) permissions, ignoring
  any active reveal. (Binds the gated restore/PIT tails T5/T6/T8.)
- **LOCK-8 — Reveal carries a reason; the reason is audited.** A reveal request accepts a `reason` (and an
  optional `ticket`); both are written into the L5 audit record. v1 does not force `ticket`; it supports and
  logs `reason` so the trail records WHY, not only who-saw-what. (Making `reason` mandatory is a policy toggle;
  recommended on.)

## 4. Where it plugs in (reuse-first; no new substrate invented)

- **Granting capability**: a new RBAC permission `multitable:history-field-audit:grant`, assignable only to
  platform/org security governance — the issue/revoke routes gate on it (LOCK-2), NOT on `canManageFields`
  (which is base-admin and authors the very `field_permissions` masks this audits).
- **Grant storage** `meta_history_audit_grants` mirrors the existing per-field/record grant shape
  (`field_permissions` / `record_permissions`: `subject_type ∈ user|role|member-group`, `subject_id`,
  `base_id` scope, `expires_at`, `created_by`, `reason`).
- **Reveal resolver** `resolveHistoryFieldAuditReveal` sits beside `loadFieldPermissionScopeMap`; when (and
  only when) the actor holds a valid grant AND the request carries the explicit reveal flag (D1), it returns
  the field IDs the grant lifts. The shared path UNIONs that into the allowed-field set built by
  `buildHistoryAllowedFieldsBySheet` (and the per-record allowed-set) — so #2968's fail-closed / no-row-lift /
  admin-asymmetry guarantees all still hold; we only widen the FIELD set, only for a valid reveal.
- **Self-audit + grant-issuance logging** extend `AuditService` (`logComplianceEvent` / `logSecurityEvent`)
  writing to `operation_audit_logs` (`metadata` jsonb carries `{baseId, batchId/recordId, revealedFieldIds,
  reason, ticket?}` — never values). No new audit table.

## 5. Ratified decisions (2026-06-20)

- **D1 — Break-glass intent → EXPLICIT REVEAL (locked).** Default history stays #2968-masked even for a grant
  holder; the holder must explicitly trigger reveal (a "show restricted fields" action / `?reveal=1`) to lift
  the mask, and every such reveal is audited (L5/L8). Auto-reveal-on-read is rejected — it silently degrades
  into a second standing permission and hides from the user that they are exercising a high-sensitivity power.
- **D2 — Scope → BASE-LEVEL.** v1 grants are per-base. No sheet-level (fragments the admin surface) or
  field-set-level (too complex) scope in v1.
- **D3 — Grant authority → platform/org security only, via `multitable:history-field-audit:grant`.** Never
  base-admin/sheet-owner/row-admin. Encodes LOCK-2's separation of duties, self-grant ban, and no-self-widen.
- **D4 — Audit-trail home → `AuditService` + `operation_audit_logs.metadata`.** Stores field id, base +
  batch/record scope, reason, actor, time. NEVER values (LOCK-5, hard).
- **D5 — Expiry → DEFAULT FINITE.** `expires_at` is required-to-exist; the issue UX/API defaults to a finite
  window (30/90 days). A standing (non-expiring) grant must be an EXPLICIT choice and is marked as such in the
  audit record — never the implicit default.
- **D6 — Formula-taint → NOT lifted.** Reveal lifts the `field_permissions` axis only; the cross-sheet
  formula-taint drop stays masked (else a local-field reveal could indirectly leak foreign denied data).
- **D7 — Graduated metadata tier → DEFERRED.** A "which fields changed, no values" tier still leaks field
  existence / business behaviour and does not match "全字段审计". Not v1.

## 6. Staged gated TODO (each a separate opt-in; design-lock first)

- ✅ **A0 — Design-lock + ratify** — this doc; D1–D7 resolved, L1–L8 locked (2026-06-20).
- 🔒 **A1 — Grant model + contract (no reveal runtime)** — `meta_history_audit_grants` migration (mirrors
  `field_permissions`, with `base_id` scope + `expires_at` + `reason` + `created_by`); RBAC capability
  `multitable:history-field-audit:grant`; issue/revoke routes gated on it with LOCK-2 enforcement (issuer ≠
  grantee, above-base-admin, audited, no self-widen, default-finite expiry); `resolveHistoryFieldAuditReveal`
  returning "no reveal" until A2 wires it. Contract-first, lock-safe, NOT wired to the mask. Unit/contract
  tests incl. the LOCK-2 rejections + default-finite-expiry.
- 🔒 **A2 — Reveal runtime + self-audit + real-DB goldens** — wire the resolver into the shared field-mask
  path on BOTH surfaces (LOCK-6), GATED on the explicit reveal flag (D1); valid-grant holder + reveal →
  unmasked; every reveal writes the L5/L8 audit record (field ids + reason, no values). Goldens: non-holder
  masked (= today); holder WITHOUT reveal flag still masked (D1); holder WITH reveal unmasked; **row-deny still
  applies to a reveal-holder** (LOCK-4); reveal writes an audit record incl. reason (LOCK-5/L8); **reveal does
  NOT widen any restore/preview/PIT writable set** (LOCK-7); expired/out-of-scope grant → masked (LOCK-3);
  self-grant + grantee-widen rejected (LOCK-2). Mutation-checked (disable the union → holder re-masked).
- 🔒 **A3 — Audit-trail read surface** — read-only "who audited what / who granted what" view over
  `operation_audit_logs`, itself permission-gated.
- 🔒 **Future (only if ratified)** — mandatory `ticket`; sheet/field-set scope (D2); graduated metadata tier
  (D7); lifting formula-taint (D6).

## 7. Out of scope / anti-goals

- Admin bypass of field permissions outside this grant — explicitly rejected; the anti-goal this design exists
  to avoid.
- Any write / restore / PIT path consuming a reveal (LOCK-7); cross-base audit aggregation; storing values in
  the audit trail (LOCK-5).
