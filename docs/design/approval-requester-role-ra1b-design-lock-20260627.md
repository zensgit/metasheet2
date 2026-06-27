# RA-1b requester.role membership — Design Lock

> Status: **PROPOSED.** Provenance + vocabulary decided (owner 2026-06-27); runtime is a separate gated slice (do `requester.title` first). Schema verified on `origin/main`.

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
`requester.title` first (cheaper, no grammar) → then RA-1b role.
