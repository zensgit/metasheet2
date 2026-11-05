# Security actions: privilege classification and assurance policy

Date: 2026-11-06

## Scope

Two backend modules with no caller:

- `packages/core-backend/src/auth/security-action-privilege.ts` — reads a user's grant inputs on the
  caller's transaction, classifies the user as `standard` or `high` privilege, and computes a witness
  over every grant input.
- `packages/core-backend/src/auth/external-login-assurance.ts` — the assurance policy matrix, the
  policy revision, and the purpose registry with its prerequisites.

No migration, table, route, environment flag, OpenAPI change or consumer is part of this change.

## Invariants

1. **Superset.** A user is `high` whenever any persisted grant source confers platform
   administration, delegated role administration, an admin-level code or a sensitive authority code.
   Each predicate is at least as wide as the authorization reader it mirrors: case and surrounding
   whitespace are ignored, and codes are taken before namespace admission.
2. **Source.** Inputs come only from rows read on the caller's transaction connection. Token claims,
   request-user fields, the permission cache and optional-schema degradation are never consulted.
3. **Single snapshot.** All sources are read by one statement, so the classification and the witness
   describe one snapshot.
4. **Refusal on failure.** A malformed subject id, a missing or non-read-committed transaction, a
   failing statement, a missing row, more than one row, or a row of unexpected shape raises
   `PrivilegeInputsUnavailableError` (status 503, code `SECURITY_ACTION_UNAVAILABLE`, a fixed message
   and no cause). The read never returns `standard` in any of these cases.
5. **Witness.** `sha256("metasheet:security-action:privilege:v1|" + canonical(inputs))`, where
   `canonical` sorts object keys by code unit; the collections read from the grant tables arrive
   sorted by code unit, and the legacy value is encoded as stored. Any change to any grant input
   changes the witness, including a code moving between two held roles, an equal-count replacement
   of a delegated scope row, an admission flip and a reordering of the legacy array.
6. **Policy.** The matrix below. An unknown, missing or mismatched assurance level is never sufficient;
   an unknown purpose is unavailable; an unknown privilege class is treated as `high`. The function is
   total and never throws.
7. **Revision.** `SECURITY_ACTION_POLICY_REVISION` is pinned together with a fingerprint of the
   matrix, the outcome of a fixed set of classification fixtures and the witness composition. A change
   observable on any of them fails the pin until the fingerprint is re-pinned; whether the revision
   must be incremented is decided in review, and a predicate change outside the pinned fixtures is
   caught only by review.
8. **Unavailable purposes.** Every purpose is unavailable: each prerequisite is a frozen `false`,
   availability reads no environment variable, and the production entry point takes one argument.
9. **Inert.** Nothing in `src` imports either module except the classifier importing the policy
   types.

Classification does not cover account state; callers apply the account gate separately.

## Grant sources and predicates

| Reason | Source | Predicate |
| --- | --- | --- |
| `platform_admin_flag` | `users.is_admin` | `true` |
| `platform_admin_role_column` | `users.role` | trimmed, case-folded value equals `admin` |
| `platform_admin_role` | `user_roles.role_id` | any trimmed, case-folded value equals `admin` |
| `delegated_admin_role` | `user_roles.role_id` | `deriveDelegatedAdminNamespace` (`rbac/namespace-admission.ts`) yields a namespace for the value or its case-folded form |
| `delegated_admin_scope` | `delegated_role_admin_scopes`, `delegated_role_admin_member_groups` | at least one row for the user |
| `admin_level_code` | direct, role-derived and legacy codes before admission | `isAdminLevelPermissionCode` (`rbac/role-assignment.ts`), or the role editor's elevation shapes: `*`, `*:*`, a code ending in `:*`, or a first segment of `*` or `admin` |
| `sensitive_authority_code` | same code set | resource in `users`, `roles`, `permissions` with action `write`, each segment trimmed and case-folded |

Namespace admissions (`user_namespace_admissions`) are part of the witness and not a reason.
Domain-specific scope tables are not grant sources of this classifier.

## Policy matrix

| Purpose | `standard` | `high` |
| --- | --- | --- |
| `external_identity_bind` | `local_password` or `external_reauth` | refused: `SECURITY_ACTION_HIGH_PRIVILEGE_SELF_SERVICE_DENIED` |
| `login_grant_enable` | same | refused, same code |
| `external_identity_unbind` | both methods | `local_password` only |
| `login_grant_disable` | both methods | `local_password` only |

Method and assurance must pair: `local_password` with `local_password` and no method connection;
`external_reauth` with `external_platform_asserted` and a method connection that is a different
connection from the target. Otherwise `SECURITY_ACTION_ASSURANCE_INSUFFICIENT`.

## Purpose registry and prerequisites

Purposes: `external_identity_bind` (`empty_slot`), `external_identity_unbind`, `login_grant_enable`,
`login_grant_disable` (`identity_revision`).

A purpose is available only when every prerequisite it depends on is delivered: the proof service;
the local credential provenance constraint (a local credential counts as the `local_password` method
only when its provenance satisfies the assurance policy for verification methods); the authorization
input serialization contract, for every purpose whose outcome depends on the privilege class (derived
from the matrix and the delivered methods); and the purpose's own target resolution. In this
revision none is delivered, so no purpose is available.

## Tests and wiring

- `tests/unit/security-action-privilege.test.ts` and `tests/unit/external-login-assurance.test.ts`
  run in the default unit job: statement shape and subject binding, probes, every refusal reason,
  row-shape single faults, one fixture per reason, superset anchors against the approval
  administrator predicate, the web administrator literals and the role editor shapes, source
  alignment with the authorization aggregator, witness composition and ordering, the policy matrix,
  the revision pin, the registry and its prerequisites, and the CI wiring.
- `tests/integration/security-action-privilege.db.test.ts` runs against real PostgreSQL in the
  approval real-database job: schema match, one fixture per reason with a second subject holding
  every source, the superset relation to the authorization aggregator, classification from rows
  rather than the permission cache, refusal when any source table or column is unavailable,
  transaction and isolation requirements, and witness changes per input. It is excluded from the
  no-database runner and listed as a whole file in the workflow; both points are asserted by the unit
  test and by `scripts/ops/plugin-tests-parallel-contract.test.mjs`.
