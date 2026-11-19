# P1g delegated-scope writer transaction boundary — 2026-11-17

This contract covers the three delegated department/group/template application writers. Core source and test paths below are relative to packages/core-backend unless the repository-root prefix is shown. It does not enable a security-action purpose or authorize deployment.

## 01 Actor edge

Private S0 inside the command module. Do not edit `assertPlatformActorAuthority` or attendance `shareAdminEdge`. Do not add a false-legacy-claim rule, a membership-only platform rule, or a `disabled` rejection.

After the target domain refusal, read `tx.locked` for the actor. Missing, inactive, not `activated`, deleted, or purged is the existing `PlatformActorAuthorityLost` 403. `users.role === 'admin'` is enough and takes no child lock. Otherwise, on `tx` only:

`SELECT role_id FROM user_roles WHERE user_id = $1 AND role_id = 'admin' FOR SHARE`

Wrap that statement with `AUTHORIZATION_INPUT_STATEMENTS` read/set timeouts using `AUTHORIZATION_INPUT_LOCK_TIMEOUT_MS` (5000) and `AUTHORIZATION_INPUT_STATEMENT_TIMEOUT_MS` (10000). Restore the saved pair after the row is present and after no row. A thrown SQL error skips restore. No row is the same 403 and no DML. Hold the share through commit.

Gate, both orders, then restore the source: delete of that child before the share returns 403 and no scope or group DML; the share first blocks that delete until commit. Deleting the `FOR SHARE` text makes the block oracle red. Raw-admin with no `admin` child still commits.

## 02 Fresh target namespace

`roleIds` use only the already-canonical raw parent projection defined below, frozen before the entry; namespace authority retains the complete raw membership input. Add `SET_DELEGATED_SCOPE` to `ROLE_ROW_SHARE_INTENTS` so those parents are `FOR SHARE` before every R3 and every R5. Missing stays `held|missing`. No R1, takeover, `sharedAcquire`, `tx.acquire`, post-R5 role lock, permission-code predicate, or role-content predicate. An actor `A_admin` membership does not satisfy the target.

Under the entry locks, re-read the target's `user_roles` and derive again. Assign and both apply modes 409 `ROLE_DELEGATION_NAMESPACE_NOT_HELD` with no DML when the requested namespace is absent. Scope unassign and group unassign do not.

Two oracles, not one: added `B_admin` while `A_admin` remains still writes namespace A. This rejects set equality. Separately, after discovery and before target R3, commit removal of the target's last A membership and leave the `A_admin` role row. The real re-read returns that 409 and no DML. A mutant that trusts the preview attempts the write and is red.

## 03 Busy body

These three catches only, copied from `admin-users.ts` L6178–6179, and not via `sendIfRecoveryAuthorityBusy` or a change to `sendAdminUsersServerFailure`:

`409` `{ ok: false, error: { code: 'AUTHORIZATION_INPUT_BUSY', message: 'Authorization inputs are busy; retry this change.', details: { retryable: true } } }`

The kernel already maps acquisition and awaited-work `55P03`, `57014`, `40P01`, and non-marker `40001`, plus its connection-loss rules, to `AuthorizationInputBusyError`. One default root, no replay, no audit and no readback on that refusal. `XX000`, post-work failure, uncertain COMMIT, and post-commit readback keep their current boundary. Recovery-marker `40001` stays the route 500 (`ROLE_DELEGATION_SCOPE_UPDATE_FAILED`, `ROLE_DELEGATION_GROUP_SCOPE_UPDATE_FAILED`, or `ROLE_DELEGATION_SCOPE_TEMPLATE_APPLY_FAILED`). Old non-marker `40001` and `40P01` were that 500; the new body is inherited LR-8 alignment.

## 04 Writers and ratchet

Three public data-only commands, each one frozen data argument and `withAuthorizationInputTransaction(plan, async (tx) => typedWriter(tx, …))`. No third argument, runner, callback hook, or caller token. Plan intent `SET_DELEGATED_SCOPE`; subjects are sorted unique `[actorId, targetId]`; `userIds`, `admissionUserIds`, and both witness lists are those subjects. No `platformAdminInvariant`.

Private writers, each `(tx: AuthorizationInputTx, …)`, own every literal. Registry symbols and multisets:

| Symbol | Literals |
|---|---|
| `writeDelegatedAdminScopeOnTx` | `delegated_role_admin_scopes` INSERT 1, DELETE 1 |
| `writeDelegatedAdminMemberGroupsOnTx` | `delegated_role_admin_member_groups` INSERT 1, DELETE 1 |
| `applyDelegatedScopeTemplateOnTx` | both tables DELETE 1, then both tables INSERT 1 |

Scope INSERT/DELETE exist in the first and third. Group INSERT/DELETE exist in the second and third. `ON CONFLICT DO UPDATE` stays one INSERT literal. Public commands and arrows contain no write literal.

Inside the typed writer, order is fixed: `requireWritableTarget`; actor S0; fresh target namespace or the unassign skip; W-12 stored `include_children` or W-14 template `FOR UPDATE`, child reads, and empty/exact refusals; then plan identity (`tx.plan` is the frozen plan), every planned parent `held|missing`, and both witness sets equal the subjects; then DML. Domain 404/409/403 precede the witness contract error.

Main-owned guard edits in `authorization-input-writers.guard.test.ts`, not an exemption and not a scanner rewrite: this module matches each literal to its enclosing symbol, checks that symbol's multiset, and requires the three symbols to cover every literal of these two tables in the module. Global file/table/verb totals and every other entry, including P1f, stay on the current ratchet. Reject an orphan, a moved or duplicate literal, a non-`tx` receiver, a wrong symbol, and an untyped token. Also add this module's brand import and two lock imports. `pending` may remain until that proof is green; `pending` is not the proof. Status becomes `converted` only with it.

## 05 Delivery files

1. `src/admin/delegated-scope-commands.ts`
2. `src/routes/admin-users.ts` (three handlers, preflight and post-commit unchanged)
3. `src/rbac/authorization-input-lock.ts` (one share-set member)
4. `src/rbac/authorization-input-writers.ts` (three symbols and multisets)
5. `tests/unit/delegated-scope-commands.test.ts`
6. `tests/integration/delegated-scope-writers-transaction.db.test.ts`
7. `packages/core-backend/vitest.config.ts` (quote that PG path once in the default exclude)
8. `tests/unit/authorization-input-writers.guard.test.ts`
9. `.github/workflows/plugin-tests.yml` (main)
10. `scripts/ops/plugin-tests-parallel-contract.test.mjs` (main)
11. `docs/development/p1g-delegated-scope-writers-design-lock-20261117.md` (install this lock only after PASS-to-implement)

PG owner is job `approval-db`, step `approval-real-db-integration`, whole-file `vitest.integration.config.ts`, `EXPECT_DB=1`. Insert the new path once, immediately after `tests/integration/admin-grant-receiving-reader.db.test.ts`. The Node contract asserts that single occurrence, the executable step, one exclude quote, and red `remove` / `duplicate` / `move` controls, and it keeps the existing sibling assertions and baseline hashes. This design claims no CI run. A green default unit job with the PG file excluded and absent from that step is not acceptance.

## Preserved behavior

W-13 `SELECT id FROM platform_member_groups` runs for assign and unassign before the assign-only namespace check. A missing group is 404, not a zero-row delete. W-12's active-department check stays assign-only. Neither existence check moves inside the transaction.

`fetchUserProfile` uses `visibleUserPredicate`. An already recycled or purged target is preflight 404 `NOT_FOUND`. Recycle after that preflight is locked 409 `USER_IN_RECYCLE_BIN`. Missing actor is 403. Inactive and pending targets stay writable. Target refusal is tested before actor refusal.

`mode` stays `String(req.body?.mode || 'replace').trim().toLowerCase()`. Invalid `includeChildren`, exact `'true'` rollout, and omitted intent preserving stored `false` stay. W-14 locks the template after R5, reads both child lists, and refuses missing, empty, or exact-disabled before either replace `DELETE`. Responses keep the preflight profile. W-12 and W-13 audit then read. W-14 reads, audits, then filters to derived namespaces. Zero-row delete remains success only after those prechecks. No W-03 cleanup and no new cache call.

## Request ownership and two-stage token assertions

Each public command synchronously copies every caller-controlled value into a fresh, command-owned immutable request snapshot **before its first await**, including discovery awaits. Copy all scalar fields and clone/freeze nested data such as the include-children intent; never freeze/mutate caller-owned objects or arrays, require callers to freeze them, or retain them for later reads. All discovery and subsequent decisions use only that snapshot. After discovery, clone/freeze the discovered parent list and construct the fresh deep-frozen context and five-key plan (`intent`, `roleIds`, `userIds`, `admissionUserIds`, `witness`) before entering the single default root. This does not add validation or change the existing coercion/normalization rules.

At each private writer boundary, before its own SQL or business use of token state, assert the registry-backed genuine/open/same-connection token, exact `tx.plan === context.plan`, frozen context/plan/nested lists, `SET_DELEGATED_SCOPE`, shared world, and exact expected parent/subject/witness **plan lists** derived from the owned context. Reject undeclared plan fields/options and a cloned/cross-call plan; a boolean `open` property or TypeScript cast is not proof. This structural assertion must not require an absent actor/target row to exist. Then preserve target-before-actor domain checks and the v2 namespace/template/rollout refusal order. Immediately before the first business DML, after the intervening awaited reads, repeat the structural assertion and check actual `tx.roleRows` keys/states exactly against the declared parents (`held|missing`, never require all held), actual R3/R5 witness sets and actual locked subject keys exactly against sorted deduplicated actor/target subjects. No born-row substitute, undeclared subject, late parent acquisition, caller-data reread or pool/nested root is allowed; every subsequent DML remains on that same token and frozen context. Missing target/actor domain refusals must occur before actual-witness equality errors; malformed/unbranded/closed tokens remain contract failures, not domain successes.

### Required boundary tests

**Mandatory discriminating implementation gates:** mutate the original top-level input and nested intent during the first discovery await: plan, decision and DML must still use the initial values, while the caller's objects remain mutable. A freeze-without-clone mutation must fail that control.
Exercise unbranded/closed/cross-call or cloned-plan tokens and corrupted expected-parent/actual-witness metadata with otherwise valid domain rows: no business DML. Separately, missing target stays 404, missing actor stays 403 after target checks, and recycled-after-preflight target stays 409—not plan 500. Actor=target is deduplicated.

## Canonical-raw parent projection and legacy compatibility

Preserve a detached snapshot of the raw target membership strings returned by the existing reader. For parent discovery only, select strings that are nonblank, already equal to their own `trim()` result, and accepted by `deriveDelegatedAdminNamespace`; deduplicate and code-unit-sort those **unchanged raw strings**, then clone/freeze that list as `plan.roleIds` and the context's expected parent list. “Canonical” means only the existing kernel spelling rule, not UUID/catalog validation. Do not trim, case-fold, rewrite, reject or clean up noncanonical memberships. An empty parent projection is valid for assign/apply as well as unassign when legacy deriving memberships are all noncanonical. Both preflight and the locked fresh namespace predicate continue to read **all raw strings admitted by the old reader** and apply the unchanged legacy derivation; they must never use the filtered parent projection as authority. All actor/target, rollout, template, refusal, response and post-commit rules remain unchanged.

Boundary and pre-DML parent checks compare exactly against this canonical-raw projection. `tx.roleRows` records `held|missing` only for declared canonical parents; an omitted noncanonical ID has **no entry**, not a fabricated `missing` or `held` witness. A declared canonical dangling membership still permits `missing`; an unrelated canonical role row is not locked merely because trimming a padded membership would name it. Preserve the existing complete subject R3/R5 locks, actor positive-edge SHARE and fresh target reread; never add a late parent lock, parent-existence refusal or role-union equality. Omission proves no lock on the padded parent and grants no role-content/birth/cascade-closure credit.

### Required legacy-role compatibility tests

1. With only the padded `attendance_admin` membership, valid ordinary prechecks, and no corresponding role parent, W-12 assign, W-13 assign and both W-14 apply modes keep their old successful outcomes/persisted effects. Assert `roleIds: []` and unchanged raw-derived namespace, not merely HTTP status. Existing unassign and domain-refusal rules remain unchanged.
2. Add an unrelated canonical `attendance_admin` role row (and optionally the padded row), without a canonical membership: the plan/SQL trace must lock neither on behalf of the padded edge. A “trim then lock” mutant must go red on that exact lock-set oracle even if its response stays 200; directly passing the padded ID to the plan must go red on the canonicality error.
3. Mix canonical and padded deriving memberships: only canonical raw IDs appear in the sorted parent plan, before all R3/R5; namespace derivation includes both. A canonical dangling membership remains accepted with `missing` metadata. A mutant filtering the authorization read rather than just the parent projection must fail the padded-only success case.
4. Remove the last padded A-deriving membership after discovery but before target R3: locked assign/apply must still give the existing namespace 409/no DML. This protects freshness despite an empty parent plan; added unrelated B still must not trigger set-equality refusal.
