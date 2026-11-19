# Authorization consumer role witnesses — B2 prerequisite

## Scope and non-goals

This contract covers only a planned role-row witness for `CONSUME_CLASS_DECISION` in the authorization-input transaction entry. It does not authorize a login grant, add a production consumer, enable a proof purpose, implement identity maintenance, or claim the directory B2 feature is delivered.

Implementation starts only after independent review of this contract. Deployment, migration, environment access and publication are outside this local slice.

## Contract

1. A self-managed `CONSUME_CLASS_DECISION` plan may name `roleIds` as read-only witnesses. Existing canonical-ID validation, deduplication and code-unit ordering apply. This does not permit writing role content, membership or other classifier inputs.
2. The entry uses the existing role `FOR SHARE` statement, not `FOR UPDATE`, for every planned role before namespace-admission and user-row locks. Order remains R0(shared), optional R1, sorted R2R roles, sorted R3 admissions, sorted R5 users. There is no exclusive-world fallback or upgrade.
3. A missing planned consumer role is a failure, not an empty permission source or a lock held. Restore the transaction-local timeout settings and reject before R3/R5 or `work` with the existing `AUTHORIZATION_INPUT_PLAN_INVALID` / `role_row_not_held` contract error. Do not include role/user values in the error.
4. Consumer plans without role witnesses preserve their existing statements and behavior. The missing-row semantics of all other intents remain unchanged, including membership intents and role-content upgrades.
5. Roles are planned before entry; `tx.acquire` remains closed to role additions and remains unavailable to consumer intents for late user/admission batches. A changed membership/source set must be rejected by the future consumer, never repaired by taking lower-ranked locks after user rows.
6. No takeover caller, intent, prefix or entry convention is broadened. No registration status moves to converted; no production purpose changes from unavailable to available.

## Limits of the primitive

Holding a role row is not a proof that every competing permission writer participates. The future consumer must discover and recheck the complete relevant role set, hold actor/target witnesses, satisfy the actor and target classification contracts, and prove all competing writers are covered. This slice does not supply that consumer or close those obligations.

This slice adds no R2 identity slot, source-freeze slot, same-platform replacement, grant storage, session revocation, real-time invalidation, actor/target delegation proof or migration path. All their existing prerequisites remain in force. No new flag, schema, API route or UI behavior is introduced.

## Verification gates

| Gate | Required evidence |
|---|---|
| G1 | A canonical consumer plan with roles succeeds with sorted/deduplicated share locks before its admission and user locks; optional R1 and actor=target remain valid |
| G2 | A missing planned role refuses before domain work and before lower-ranked locks; timeout restoration and rollback/cleanup are asserted |
| G3 | No-role consumers and all old intents retain behavior; malformed IDs, late role acquisition, world promotion and takeover remain refused |
| G4 | Removing consumer eligibility, bypassing the missing-role refusal, or taking update instead of share locks makes the corresponding regression fail; exact source restoration |
| G5 | Whole-file authorization-input contract tests plus neighbors run on final local source; original unrelated regressions are not removed |
| G6 | Independent code review closes blocking findings; unit/mock evidence is not real PostgreSQL concurrency, production writer coverage or B2 readiness |

Real database lock/conflict acceptance remains required before this primitive can be counted as an integrated B2 authorization proof. If it cannot be executed in the authorized local environment, report it as unrun rather than skipping green.

Add the corresponding share-compatibility, update-conflict and missing-role cases to the existing, whole-file CI-registered `authorization-input-serialization.db.test.ts`. Do not create an unregistered database suite or run a skip-shaped no-database invocation as acceptance evidence.
