# Admin grant receiving invalidation design lock — 2026-11-17

This slice adds dormant invalidation for existing receiving rows only. It does not admit first population, mint authority, a security-action purpose, strict login or deployment. Author scope is the new migration `packages/core-backend/src/db/migrations/zzzz20261117183000_admin_grant_receiving_invalidation.ts` and new spec `packages/core-backend/tests/integration/admin-grant-receiving-invalidation.db.test.ts`; main alone owns the three integration paths in F5. S1 migration, reader, codec, classifier and existing material writers remain unchanged.

Dependency order is S1 receiving, then the installed P1g delegated-scope spec, then S2. S2 is not an immediate-after-S1 workflow insert.

## F1 — pin identity

No custom GUC, `set_config` marker, or `pg_trigger_depth` authority.

`BEFORE UPDATE` on `directory_connection_application_pins`: `NEW.connection_id` must equal `OLD.connection_id`. `BEFORE UPDATE` on `user_external_identity_binding_pins`: `NEW.identity_id` must equal `OLD.identity_id`. A rekey raises `55000` even when the revision spelling is the legal successor.

Application-pin `DELETE` always raises `55000`.

Binding-pin `BEFORE DELETE` runs `SELECT 1 FROM user_external_identities WHERE id = OLD.identity_id`. If that identity is visible, raise `55000`. If it is not visible, the delete continues. That is the FK cascade after the identity row is gone to this transaction. Direct delete, `SET LOCAL` of any name, and a stale marker in a later statement of the same transaction still see the identity and refuse. A following `INSERT` of the old key is not a revision continuation.

Same-transaction oracle, real triggers: direct delete/reinsert refuses; both PK rekeys refuse; `DELETE` of the identity after a committed legal evidence detach cascades only the binding pin and keeps evidence history; `DELETE` while `live_identity_id` is set rolls back the whole cascade, including any pin delete. User delete reaches that identity FK (`zzzz20260323133000` L28–38) and uses the same rule. S2 does not revoke inside `DELETE`.

## F2 — capability delete

`BEFORE DELETE` on `directory_integration_capabilities`: raise `55000` when an application pin exists for `OLD.integration_id` or any `user_external_identity_evidence` row exists for that connection, `revoked_at` null or not. The probe is plain `EXISTS` / `SELECT 1` with no `FOR SHARE`, `FOR UPDATE`, or `FOR KEY SHARE`. When both are absent, delete stays allowed under today's FKs. `dic_guard_update` is not altered. A later capability `INSERT` is not a continuation of a deleted revision.

`ON DELETE RESTRICT` at capability migration L97–100 stays. No runtime capability-delete consumer is claimed beyond the review's narrow check.

## F3 — down

New migration only. Codes `ADMIN_GRANT_INVALIDATION_DOWN_REQUIRES_TRANSACTION`, `ADMIN_GRANT_INVALIDATION_DOWN_REQUIRES_READ_COMMITTED`, `ADMIN_GRANT_INVALIDATION_DOWN_BLOCKED`.

Before any lock or drop: caller transaction id is stable across two `pg_current_xact_id()` reads, and `current_setting('transaction_isolation')` is `read committed`. Autocommit and every other isolation raise and change nothing.

Then read `lock_timeout` and `statement_timeout`, and `set_config` both to `5s` and `5min` with `is_local` true. Prerequisite `to_regclass` for `directory_integrations`, `directory_integration_capabilities`, `user_external_identities`, and the three receiving tables. A missing relation raises before any drop.

Then `LOCK TABLE` `ACCESS EXCLUSIVE`, held until the caller commits or rolls back. `down` does not `COMMIT`. Order: `directory_integrations`, `directory_integration_capabilities`, `user_external_identities`, `directory_connection_application_pins`, `user_external_identity_binding_pins`, `user_external_identity_evidence`. Parent locks are the locks `DROP TRIGGER` requires, taken before the empty check so they cannot upgrade afterwards. Receiving locks match S1's down order.

Then emptiness of the three receiving tables. A row raises blocked and drops nothing. Only if all three are empty, drop S2 triggers and S2 functions. No S1 table, S1 function, or parent table is dropped.

Success path restores both timeouts with `set_config(..., true)` before return. A SQL error, `40P01`, lock timeout, or statement timeout propagates with no catch and no retry; rollback reverts the local timeouts and every partial drop. A JavaScript refusal while the transaction is still healthy restores the timeouts in `finally` and rethrows. Restore SQL is not issued after an aborted statement.

Oracles: a row committed before the empty check blocks down and leaves triggers; an insert that starts after the exclusive locks and before drop cannot commit until down ends, so it cannot land between check and drop; non-RC and autocommit refuse; a lock failure leaves every S2 object and every retained row.

Runtime statements still take no advisory lock, no R2, no R2F, no `MAINTENANCE`, and no extra table lock. That sentence is not a claim about `down`.

## F4 — deadlock

v1's claim that overlapping evidence waits are one-directional is withdrawn. `ORDER BY` inside one invocation is not a cross-parent proof. Existing FK and trigger locks in the enclosing statement remain, including `guard_dingtalk_repaired_identity` (`zzzz20261102150000` L34) taking users `FOR SHARE` after the identity row lock. S2 still does not lock `users`.

Evidence locks are an explicit loop, the same function for both parents: `SELECT id … ORDER BY id FOR UPDATE`, then for each returned id check the bigint and `UPDATE` that id only. One `UPDATE … FROM (SELECT … ORDER BY id)` is not the implementation.

Schedule, no savepoint. Opaque ids with `E1 < E2` in that same `ORDER BY id` order. Live evidence `E2` on identity `I2` and `E1` on identity `I1`, both `connection_id` C. Transaction A updates `I2`'s slot, its loop holds `E2`, then updates `I1` and waits for `E1`. Transaction B updates integration C and its loop holds `E1` then waits for `E2`. The cycle is on the evidence rows. Neither identity invocation locks the application pin.

`40P01` aborts the victim transaction whole: that attempt's parent change, pin step, and evidence updates roll back together. The other transaction may commit its own complete invalidation. The contract does not require both to abort. Nothing catches `40P01`, retries, or adds an advisory framework. The repair-trigger user/identity inversion is the same whole-victim rule when it fires.

## F5 — files and lane

Focused spec is new. It is not appended to the S1 spec. `EXPECT_DB=1` without `DATABASE_URL` throws at load. Default vitest does not collect it. Main runs the whole file with zero skips. It imports the real migrations, uses owned fixtures, and keeps source-fault red→exact-byte restore. Cleanup drops only owned fixtures.

Main-only registration, one node, no workflow run in this design turn:

1. `packages/core-backend/vitest.config.ts`: one quoted `'tests/integration/admin-grant-receiving-invalidation.db.test.ts',` immediately after the existing `'tests/integration/delegated-scope-writers-transaction.db.test.ts',` (L476). Occurrence count 1. Deleting it or commenting the quotes makes the exclude helper false.
2. `.github/workflows/plugin-tests.yml` job `approval-db`, step id `approval-real-db-integration`: one argument `tests/integration/admin-grant-receiving-invalidation.db.test.ts \` immediately after `delegated-scope-writers-transaction.db.test.ts` (L2748) and before `directory-source-freeze-lock-correctness.db.test.ts` (L2749). The job matrix is `node-version: [20.x]` (L2508), so the required lane is one Node 20.x run. No other job and no added matrix entry.
3. `scripts/ops/plugin-tests-parallel-contract.test.mjs`: before the existing delegated-scope strip (L297), assert the new line occurs once and only as `delegatedScopeWriterAddition + invalidationAddition`; strip only that addition before the frozen digest. Keep `adminGrantReceivingAddition + delegatedScopeWriterAddition` (L296). Baseline remains `sourceCommit` `2006826d772b9f693d878bff7d18bf275dead299` and 129 original steps (L356–358). Add the file to the ownership loop at L416–419: one `approval-db` occurrence, quoted exclude count 1, and `remove` / `duplicate` / `move` to `runtime-db` throw. An edit that places the new line between the S1 spec and the P1g spec fails the adjacency assert.

## Projection, successor, bigint

Four keys, reader L23–24 and L264–289, no trim and no decrypt. Per key: absent → class `missing` and text `''`; `jsonb_typeof` `string` → class `string` and the exact string (`#>>'{}'` only after the type test); `null` on `baseUrl` or `workNotificationAgentId` → class `null`; every other type, including `null` on `appKey` or `appSecret`, → class `invalid` plus `jsonb_typeof`. Compare the four pairs with `IS DISTINCT FROM`. String `"1"` and number `1` differ. Missing and null differ. A non-object config is class `invalid` plus the container type. The trigger does not hash. `material_fingerprint` stays stored.

`application_revision` successor is a digit map on the canonical spelling `^(0|[1-9][0-9]*)$`: `'0'`–`'8'` become the next digit and clear carry, `'9'` becomes `'0'` and keeps carry, a remaining carry prefixes `'1'`. Input `0` yields `1`. Thirty `9` characters yield `1` and thirty `0` characters. No `::bigint`, `::numeric`, `Number`, or `parseInt`, and no extra ceiling. The guard accepts only that exact spelling. The spec passes the thirty-`9` value as text.

Binding `binding_revision` and evidence `revocation_generation`: if old equals `9223372036854775807`, raise `55000` before any addition. The parent statement rolls back. No wrap, reset, or revoke left behind. Evidence `UPDATE` still changes only generation and `live_identity_id`, and the S1 guard stamps `clock_timestamp()`.

Both pin UPDATE paths enforce exactly one successor for direct statements as well as parent-trigger writes. Application updates require the exact canonical text successor. Binding updates require `NEW.binding_revision = OLD.binding_revision + 1` after the maximum check and reject unchanged, decreasing, skipped or NULL revisions. Tests cover raw direct statements and parent-trigger writes; immutable keys and exact successor checks are independent requirements.

## Existing-row behavior

`AFTER UPDATE` on an integration or identity returns without a write when that parent has no pin and no unrevoked evidence. `INSERT` creates no receiving row.

Integration scope is `org_id`, `provider`, `corp_id`, or a distinct four-key projection. Then the application pin, if present, takes one successor step and each unrevoked evidence row for that connection is revoked through the loop above. Identity scope is the six reader slot columns only (`provider`, `local_user_id`, `external_key`, `corp_id`, `provider_open_id`, `provider_union_id`). The binding pin, if present, copies those NEW values and steps `binding_revision`. Then that identity's unrevoked evidence is revoked. Identity triggers do not lock the application pin or the capability row. Integration triggers do not lock identities, binding pins, or capabilities. Capability `UPDATE` stays on its existing `old+1` guard and does not step `application_revision`.

`updateDirectoryIntegration` (`directory-sync.ts` L2925, decrypt L1915–1919, encrypt L3004–3007, random IV `encrypted-secrets.ts` L235) rewrites ciphertext on a name-only form save. With a pin or live evidence, that stored-text change steps the pin and revokes the evidence row. `saveDingTalkWorkNotificationAgentId` (L594–627) does the same for a repeated agent id. With no receiving row, both commits stay successful and insert nothing. `integrationScopedEvidence` stays false.

A raw `UPDATE` that changes only `name`, `status`, schedules, or other non-config columns, and leaves `config`, `org_id`, `provider`, and `corp_id` unchanged, does not step or revoke. `updateDirectoryIntegrationIdentity` (L3095–3146) merges `corpName`, `appName`, and `identityVerification` and does not rewrite the four material values, so it does not step or revoke. Those two are display-only. The general form save is not.

Receiving v2 allows that conservative evidence invalidation. It does not ratify revocation of an active login or grant. For this inert slice the pre-enablement gates stay false, with no owner question and no writer patch: evidence revocation does not propagate to login or grant; benign re-encryption does not preserve live evidence. Both remain false until a later design, before any producer or login enablement.

Provider or org changes that a capability row covers still fail that FK and roll the statement back. `corp_id` is outside it, so a corp change commits the step and revoke. Live evidence still `RESTRICT`s identity delete.

## Not closed

First pin or evidence birth stays unavailable. An empty observation is not a lock against a later mint. FK `KEY SHARE` does not block a non-key parent `UPDATE`. Counterexample, unresolved on purpose: a raw repeatable-read writer fixes its snapshot while no pin exists; a later producer commits the first pin and evidence; the same snapshot then changes material A→B→A and can still see no receiving row, so the old-A evidence stays eligible. Parent `FOR SHARE` taken earlier by a producer does not refresh that snapshot. The spec records this as an admission hole. It is not a green universal-ABA result. S2 does not refuse ordinary empty-table writes to imitate that barrier.

S2 does not claim universal ABA closure, a producer, a login policy, historical trust, or backfill. Ciphertext A→B→A on an existing row revokes that evidence and moves the spelling two steps; that is the existing-row case only.

## Actual-relation resolution

At installation verify that the binding pin's actual S1 FK target is the expected identity relation in the same schema, and verify the S1 relation co-location used by the other triggers; otherwise refuse installation. Runtime parent and receiving-table references and S2 helper calls are schema-qualified using server-supplied `TG_TABLE_SCHEMA`, quoted identifiers and separately bound row values, with a safe function search path. Caller `search_path`, temporary shadows, a supplied schema string, a GUC and unqualified-name fallback are not authority. A hostile-lookup-path test must prove that direct deletion/reset of the real pin still refuses, legal detached-parent cascade still succeeds, and receiving-table shadows cannot redirect invalidation or capability retention. Assertions address the qualified real relations.

## Availability

`productionAvailable`, `firstPopulationAdmitted`, `universalAbaClosed`, `loginPropagationDecided` and `benignReencryptionPreservesEvidence` remain false. Completion is limited to this lock's local gates; it is not full B2 acceptance.
