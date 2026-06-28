# RA-1b FE formula-roles picker — development & verification (2026-06-28)

> Completes the curated-vocabulary feature end-to-end. The BE hard gate shipped in #3327 (`34a8f6d46`, on `main`) rejects an uncurated `requester.role` literal at publish/dry-run; this slice adds the **authoring-side convenience**: an author is now *guided* to insert only curated roles, instead of discovering the curated set by hitting a publish rejection. Branch `claude/approval-ra1b-fe-formula-roles-picker-20260628`, off `main` @ `34a8f6d46`.

## Scope (deliberately minimal, non-gated)
This is the one item the #3327 advisor flagged as deferred-but-defensible. It needs **no product/security decision** (the curated endpoint + the security boundary already exist BE-side), so it's buildable now. It does **not** touch any owner-gated item (`requester.level`, W7 backwrite, amount rules, canvas) — those remain owner-gated.

## Implementation
- **Composable** (`useApprovalDirectory.ts`) — added a **dedicated** curated path, mirroring `loadRoles()` exactly but separate from it:
  - `formulaRoles` ref + `formulaRolesLoading` + `loadFormulaRoles()` → `GET /api/approval-templates/directory/formula-roles` (curated, `approval_usable=true`; bare `{ roles }` shape; same 403/error handling).
  - The pre-existing `loadRoles()` / `roles` (the SHARED `static_role` approver picker, which lists ALL roles) is **unchanged** — the prior `TODO(RA-1b FE)` is retired and replaced by a doc note. The curated and full role sets are never merged (the ratified boundary).
- **View** (`TemplateAuthoringView.vue`):
  - In the condition-formula tools row (formula mode only — inside the `predicateMode === 'formula'` `v-else` block, after the SUM/COUNT/MIN/MAX inserts), a curated-role affordance: a `requester.role（审批可用角色）` hint + one button per curated role (label = `formatRoleLabel`), rendered only when `directory.formulaRoles.value.length > 0`.
  - `insertConditionFormulaRoleMembership(branch, roleId)` appends a ready `requester.role in [${JSON.stringify(roleId)}]` snippet (JSON.stringify quotes/escapes the id → always parses). Single-role is the common case; multi-role is a manual array edit. Uses the same append-only `appendFormulaText` model as the existing field/aggregate inserts.
  - `directory.loadFormulaRoles()` called at `onMounted` alongside `loadRoles()` (behind the same `canManageTemplates` guard).
  - Hint CSS (muted, small) added next to the existing formula-tools styles.

## Verification
- **`useApprovalDirectory.spec.ts` 12/12** (3 new): `loadFormulaRoles` hits the **curated** `/formula-roles` endpoint + parses `{ roles }`; **separation** — `loadRoles` vs `loadFormulaRoles` hit different endpoints and fill separate refs (static_role keeps `admin`, the curated picker excludes it); 403 clears `formulaRoles` + sets the permission message.
- **`vue-tsc -b` clean** (0 errors) — template binding (`directory.formulaRoles.value`, consistent with the existing `directory.roles.value` access in this file) + the new method typecheck.
- **Boundary preserved** — `static_role` picker (`directory.roles`, line 992) and `loadRoles()` are byte-unchanged; the curated affordance is additive and formula-mode-scoped.
- **Insert correctness** — the emitted `requester.role in ["<id>"]` is exactly the membership grammar the BE parser + curated publish gate accept (proven by #3327's grammar + DB tests); JSON.stringify guarantees a parseable literal.

## Invariants
- `static_role` approver selection is unaffected; the curated picker is a separate, additive surface. ✓
- The picker fetches only curated roles; it is authoring convenience, NOT the security boundary (the BE publish/dry-run gate from #3327 remains the enforcement). ✓
- The affordance renders only in condition **formula** mode and only when curated roles are present. ✓

## Still owner-gated (unchanged)
`requester.level` (title→rank mapping decision), W7 rejection/cross-base/person-writer backwrite (named scenario + security), amount rules (product+security), canvas polish (deprioritized UX). Each is a separate opt-in.
