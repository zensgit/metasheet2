# Platform namespace admission bulk transaction boundary

## Scope and availability

This lock covers only the existing platform-admin `POST /api/admin/users/namespaces/:namespace/admission/bulk`. It is a local B2 prerequisite. The single-target command and every other caller stay unchanged. W-16 remains pending; no login, proof purpose, identity producer, feature flag or deployment is enabled. Design review precedes implementation.

## Command and lock boundary

- Introduce one separate data-only `writePlatformNamespaceAdmissionBulkCommand({ actorId, namespace, enabled, userIds })`. Snapshot the three scalars and clone the target array synchronously before the first await. Freeze only command-owned objects and arrays, never caller-owned data.
- Use one default READ COMMITTED `withAuthorizationInputTransaction` for the whole batch, never a loop of single-target roots. Build the code-unit sorted distinct target list and the sorted distinct union of actor and targets.
- The frozen plan has exactly `intent`, `roleIds`, `userIds`, `admissionUserIds`, `witness`; intent is `SET_ADMISSION`, role parents are empty, and both subject lists and both witness lists equal the complete subject union. R0 is shared, no R1 or R2, all R3 precede all R5. Do not add an intent, batch cap or lock family.
- Require a genuine open same-connection token with `tx.plan` equal to the owned plan and shared world. Check exact plan/witness keys, owned frozen context, target/parent/subject arrays, plan and both witness arrays. Immediately before the first business helper, recheck structure and exact actual locked/witnessed subject sets and empty role-row keys. Born subjects are not held/witnessed subjects. No caller transaction, runner, hook, nested root or extra lock helper.

## Existing domain and authority

- Keep the route's current string-only list normalization: trim, discard empty/non-string entries and encounter-order deduplication. Non-array becomes an empty list and the existing 400. Keep namespace, controlled-resource and boolean validation and request-time platform-admin gate.
- Keep existing preflight `users` existence lookup without a new visibility filter. Missing IDs return existing 404 `USERS_NOT_FOUND`, preserving missing-ID request order. No stricter target-ID policy from another API is imported.
- Inside the root, preserve actor authority before all target writability checks. Actor403 precedes an in-root recycled-target409. All targets must pass before the first helper call: missing gives `NOT_FOUND`/404, deleted or purged gives `USER_IN_RECYCLE_BIN`/409. Inactive and pending targets remain writable.
- Actor S0 is the existing locked active, activated, non-recycled account with raw `users.role='admin'` OR exact live `user_roles.admin` membership. Retain the existing locked representation, including `COALESCE(is_active, TRUE)`; no token-only, wildcard or `is_admin` substitute.
- Raw admin performs no child query. Membership-dependent authority uses same-token exact `user_roles(user_id=actorId, role_id='admin') FOR SHARE`, distinct from role-parent R2, retaining the existing timeout save / 5000-10000 window / restore on successful row or no-row completion. SQL failures propagate without restore SQL in an aborted transaction. Hold positive SHARE through commit. Do not export or modify the single-target command's private helpers.

## Atomic writes and post-commit compatibility

- Call existing `writeUserNamespaceAdmission` once per sorted distinct target on the same branded token, with `{ userId, namespace, enabled, actorId, source: 'platform_admin' }`. No copied DML, new raw transaction or shared-writer change. Actor=target is one lock subject and one target write.
- Any pre-commit failure rolls back the whole batch, including a failure on a later helper. No user, identity, role, proof or audit write is added inside the root.
- Preserve request-order permission-cache invalidation and audit `Promise.all`, `mode: 'bulk'`, `selectionSize`, and existing response fields/order/count. Do not add a list readback. A post-commit audit failure remains500 with cache already applied and no replay; it does not imply rollback.

## Errors

- Only this POST catch adopts inherited `AuthorizationInputBusyError`: 409 `{ ok: false, error: { code: 'AUTHORIZATION_INPUT_BUSY', message: 'Authorization inputs are busy; retry this change.', details: { retryable: true } } }`.
- Eligible acquisition/awaited-work 55P03, 57014, 40P01 and non-marker40001 use that typed response. Recovery-marker40001, XX000, uncertain COMMIT acknowledgement and post-commit errors retain the old `MEMBER_NAMESPACE_ADMISSION_BULK_FAILED` boundary. No adapter, automatic retry or replay. Pre-commit refusal yields no cache/audit effects.

## Verification gates

1. Preserve existing route validation, normalization, preflight and request-order response/cache/audit behavior. Test actor=target, caller-array mutation after snapshot, multi-target lock/write ordering and inactive/pending targets. No new batch limit.
2. Genuine/open/connection/plan-identity/frozen-shape/partial-witness/extra-parent negatives; exact importer, registered POST, direct data-object keys/bindings, with no aliases, callbacks, detached calls or caller tokens/runners. Keep the single-target caller closure unchanged.
3. Real owned synthetic PG: one root, R0 then all R3 then all R5, empty parents, exact persisted rows and unchanged neighbors, positive actor-child SHARE and concurrent deletion in both orders. Mutating critical guards/physical lock must yield behavioral red, byte-exact restore, then green; callback start must be observed independently of transaction liveness.
4. Actor403 versus recycled-target409 precedence, all target checks before first write, later-target helper failure with complete batch rollback, eligible SQLSTATE409 versus marker/XX000500, uncertain COMMIT/post-commit effects and no replay. Separate injected error surfaces from physical locking evidence.
5. Whole new unit/PG files and adjacent regressions. `EXPECT_DB=1` without URL must fail at load; unreachable owned target must fail, not skip-shaped green. Filtered assertions are unexecuted. Local Node24 evidence does not claim Node20 or remote CI.
6. Main alone registers the whole new PG file once after the single-target admission file in the existing required approval-db lane, default unit exclusion and exact Node ownership guard. Preserve the union of all existing test-chain entries and removal/duplicate/relocation negatives.

## Ownership and limits

Grok authors the new command, this POST replacement and focused unit/PG specimens in disjoint write sets. Codex integrates shared guard/CI changes, serializes all test/PG execution, restores source faults and owns final validation. Independent review is required for bounded local acceptance. Only the existing owned synthetic database is allowed. No installation, commit, push, deployment, staging or real-account/provider operation is authorized.
