# RA-1b requester.role membership — Design Lock

> Status: **RATIFIED — RUNTIME SHIPPED + CURATED-VOCABULARY ENFORCED**. Provenance + vocabulary decided (owner 2026-06-27); the `in`-grammar runtime + role resolver shipped (merged on `origin/main`); the curated-vocabulary enforcement (this slice, 2026-06-27) closes D-role-vocabulary. Schema verified on `origin/main`.

## Facts
- `directory_accounts` has **NO** first-class role/position column. A DingTalk `role_list` may sit unextracted in `directory_accounts.raw` — **NOT a v1 source**.
- The trusted role source is the **system RBAC**: `roles` (PK TEXT id+name; `zzzz20260208100000`) + `user_roles` (`20250924190000`). Stable enumerable PKs.
- `requester_snapshot.roles` is already frozen but from **actor/token claims (login-time)**, provenance-distinct from RA-1a department's fresh server query.

## Decisions (owner, 2026-06-27)
- **D-role-provenance = FRESH `user_roles` query at create** (department-grade tamper-resistance) — **NOT** the login-time token-claim roles.
- **D-role-vocabulary = an approval-curated subset** of RBAC roles exposed to formula authors — **NOT** all RBAC roles (do not expose system/admin roles to approval-formula authors).
- **BOUNDARY (v1 scope lock):** RA-1b v1 uses ONLY the fresh `user_roles` source. Directory `raw` role/position fields (provider-specific) **do NOT enter v1** — they would require a separate sync/extraction design lock.

## Build (after requester.title; introduces the `in` grammar)
1. **Grammar (the substantive new work)**: add the `in` operator + array-literal `["a","b"]` to the evaluator (tokenizer / parser / AST / type-check / evaluate). Shared infra, reusable.
2. **Source** (per D-role-provenance): fresh `user_roles` query at create → freeze the curated role list into `requester_snapshot` (new resolver path, NOT the token-claim roles).
3. **Evaluator**: `requester.role` → string-list value; `requester.role in [...]` membership; allowlist + the 3 edits (snapshot / requesterContext / `evaluateRequester`).
4. **Guard + tests**: wedge guard for `requester.role`; evaluator + resolver + round-trip + `in`-grammar unit tests.

## Sequence
`requester.title` first (cheaper, no grammar) → then RA-1b role → **then RA-1b CURATED-VOCABULARY enforcement (below)**.

---

## CURATED-VOCABULARY ENFORCEMENT (owner SHARP boundary correction, 2026-06-27) — SHIPPED

The shipped role runtime exposed **every** RBAC role to `requester.role in [...]`, so an author could route on
`admin`/system roles — violating ratified **D-role-vocabulary** ("approval-curated subset", §Decisions). The
following enforcement closes that gap. Each piece is fail-closed and independent of any picker.

### Curated source (the ONE source of truth)
- **`roles.approval_usable boolean NOT NULL DEFAULT false`** (migration `zzzz20260627150000_add_approval_usable_to_roles`,
  idempotent/`checkColumnExists`-guarded). **Secure-by-default**: every existing role — including `admin`/system —
  is excluded until an administrator explicitly opts it in.
- **Curated set = `SELECT id FROM roles WHERE approval_usable = true`** (`fetchCuratedApprovalRoleIds`).

### The HARD GATE — publish + dry-run (independent of any picker)
- **Publish** (`ApprovalProductService.publishTemplate` → `validateApprovalConditionFormulasAgainstFormSchema`):
  AFTER schema validation, `extractRequesterRoleLiterals(expression)` is checked against the curated set; any
  uncurated literal throws `ServiceError(400, 'APPROVAL_REQUESTER_ROLE_NOT_CURATED')`. The curated set is fetched
  ONCE per publish (transaction client), only when the graph routes on `requester.role`. This is THE security
  boundary — drafts may be authored, but a graph routing on an uncurated role can never be PUBLISHED.
- **Dry-run** (`POST /api/approval-templates/formula-condition/dry-run`) runs the SAME curated check (same code,
  `success:false`) so preview and publish never diverge.
- **`extractRequesterRoleLiterals`** walks the AST for `membership` nodes (attr `role`), incl. nesting inside
  `AND`/`OR`/`NOT`; returns the unique union, `[]` on parse error / non-role formulas.

### Formula `requester.role` vs `static_role` — distinct pickers
- Curation scopes **ONLY** the formula `requester.role` vocabulary, **NOT** `static_role` approver selection.
- `listDirectoryRoles` (`GET …/directory/roles`) is the SHARED author picker — it ALSO backs `static_role` —
  and is **UNCHANGED** (returns ALL roles).
- A **DEDICATED** `listFormulaConditionRoles` (`GET …/directory/formula-roles`) returns ONLY `approval_usable=true`.
  *(FE follow-up: wire the formula-condition role picker to the new endpoint; the BE endpoint + publish gate are
  the security must-haves and are shipped.)*

### Curated-freeze (resolver)
- `resolveApprovalRequesterRoleIds` INNER-JOINs `roles` and keeps ONLY `approval_usable = true`
  (`JOIN roles r ON r.id = ur.role_id … AND r.approval_usable = true`), so a SYSTEM role the requester holds can
  never enter `requester_snapshot.directoryRoles`. Dedup / trim / order preserved; still THROWS on read failure.

### Genuine-empty → DEFAULT (role is a PREDICATE, not a routing key)
- A requester with **zero curated roles** must route to the condition's **DEFAULT edge** (membership = false),
  **NOT** be 422-rejected. Consequences:
  - `directoryRoles` is **ALWAYS frozen as an array, including `[]`** (never omitted) at create, and threaded as
    `[]` (not `null`) at create + both dispatch sites — so dispatch evaluates membership to `false`, not fail-closed.
  - The create-time role wedge guard rejects **only** a TRANSIENT read failure
    (`roleReadFailed → 503 APPROVAL_REQUESTER_ROLE_UNRESOLVED`); the genuine-empty **422 is REMOVED**.
  - `evaluateRequesterMembership` keeps: `null`/`undefined` context → fail (truly unthreaded); `[]` → `false`.
  - **Department / title are UNCHANGED** — they are routing KEYS and keep their reject-on-absence (422/503).

