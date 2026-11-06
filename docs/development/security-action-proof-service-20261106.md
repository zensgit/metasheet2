# Security actions: one-time action proofs

Date: 2026-11-06

## Scope

A table, a service and one route:

- `packages/core-backend/src/db/migrations/zzzz20261106120000_create_security_action_challenges.ts` —
  the `security_action_challenges` table: one row per credential verification attempt for a security
  action.
- `packages/core-backend/src/auth/security-action-proof.ts` — issuance and consumption of a one-time
  proof, the session context the bindings come from, and the request schema of the route.
- `packages/core-backend/src/routes/security-actions.ts` — `POST /api/auth/security-actions/verify`,
  mounted only when `SECURITY_ACTION_PROOF_ENABLED` is exactly `'true'`.

No purpose is available in this revision (every prerequisite of the purpose registry is `false`), so
every verify request is refused before any data is read and the table receives no row. Nothing
consumes a proof; no binding, login grant, session or login behaviour changes.

## Invariants

1. **Unavailable purposes.** While no purpose is available, `POST /api/auth/security-actions/verify`
   refuses every purpose with `403 SECURITY_ACTION_PURPOSE_UNAVAILABLE` before the route handler or
   the service issues any statement, compares no password and writes no audit row. The global session
   gate in front of the route is not part of this statement count.
2. **Switch.** Unless `SECURITY_ACTION_PROOF_ENABLED` is exactly `'true'`, the router factory returns
   `null` and nothing is mounted, and every service entry point refuses with
   `503 SECURITY_ACTION_PROOF_UNAVAILABLE` before any statement. The route and the service read the
   same predicate; it neither trims nor folds case.
3. **Table boundary.** The table name appears in the migration and the service module only (the
   migration runner's help text names the migration file, and with it the table, without reading it);
   the service module is imported by the route module only; the route module is imported by
   `index.ts` only, inside the condition on the router factory's result, which mounts the router and
   its error handler for the same prefix and nothing else.
4. **No proof without a verification.** An issued row is written only in the second transaction,
   after the password compared equal and every input of the first read is unchanged. Session age,
   token issue time, last login and token refresh never stand in for a verification.
5. **Bindings.** A proof is bound to the user, the session, the authenticated organization, the
   purpose, the connection, the target kind and witness, the access generation, a credential witness,
   a privilege witness and the policy revision, optionally to a client binding digest. Binding inputs
   come only from a context built by `readAuthenticatedSessionContext` and from server-side reads.
6. **Single use.** A proof is consumed at most once, and only in the same transaction as the caller's
   action; if the action rolls back the proof stays issued and may be retried within its lifetime. At
   most one issued row exists per user, session and purpose; a new issuance supersedes the earlier one.
7. **Lifetime.** 300 seconds, computed by the database at insert time; consumption compares against the
   database clock. A CHECK bounds `expires_at` to at most 300 seconds after `created_at`, and the
   trigger refuses a `created_at` in the future.
8. **Failure limit.** Five rejected credentials per user within fifteen minutes refuse further attempts
   with `429 SECURITY_ACTION_RATE_LIMITED` before any password comparison; the count is per user across
   sessions and purposes, re-checked under the per-user lock, and only rejected credentials count.
9. **Fail closed.** Any read failure, missing shape, lock timeout or serialization failure refuses with
   `503 SECURITY_ACTION_UNAVAILABLE` and writes nothing; during consumption it is raised to the caller,
   whose transaction must roll back.
10. **Secret once.** The proof's secret appears only in the `200` response body; the table stores a
    domain-separated SHA-256 of it. Passwords are never echoed, logged or audited.
11. **Lock order.** The user row is always the first lock. Issuance takes a per-user advisory lock, then
    the user row (`FOR KEY SHARE`), before any proof row. Consumption runs inside the caller's
    transaction after the caller took the user row through `lockUsersForAccessGraphWrite` and any other
    row it needs; it re-enters the user row, then takes the session row (`FOR SHARE`) and the proof row
    (`FOR UPDATE`). No path waits for the user row while holding a session or proof row.
12. **Isolation.** Both issuance transactions pin `READ COMMITTED` as their first statement; consumption
    refuses a caller transaction that is not read committed before taking any lock.
13. **Transitions.** Rows are admitted only as `issued` or `failed`; the only transitions are
    `issued -> consumed` and `issued -> superseded`; any other column change is refused by the trigger
    with SQLSTATE 55000. Deletion is not intercepted.
14. **Migration hygiene.** The migration reads the lock and statement timeouts, bounds them for its own
    statements and restores the values it read; it creates the table without `IF NOT EXISTS`; its
    `down()` refuses while the table holds a row and then changes nothing.
15. **Browser side.** The route takes the session from `Authorization: Bearer` only and returns the
    proof in the response body only. If a cookie-carried session is ever introduced, this route must
    gain CSRF protection in the same change.

The account gate decides whether the session is usable (`401 SECURITY_ACTION_SESSION_REQUIRED`); whether
the local password is an eligible method is decided separately (`403 SECURITY_ACTION_METHOD_UNAVAILABLE`
with `details.nextStep`). Consumption applies the same two checks and reports either as a stale proof.

The privilege witness is compared at consumption time; purposes whose outcome depends on the privilege
class stay unavailable until every authorization-input writer serializes with consumption.

## Route contract

`POST /api/auth/security-actions/verify`, behind the global session gate and the password-change gate.
Request (closed schema): `purpose`, `connectionId` (uuid), `targetIdentityId` (uuid; required for every
purpose except `external_identity_bind`, refused for it), `expectedBindingRevision` (non-negative
integer; present exactly when `targetIdentityId` is), `method` (`local_password` only), `password`
(1–1024 characters, not trimmed), optional `clientBindingDigest` (64 lowercase hex). Unknown keys are
reported under the fixed field name `_unknown`; `details.fields` names schema fields or that fixed
entry only. A body that cannot be parsed, or that is outside the accepted size or encoding, is
answered by the error handler mounted after the router for the same prefix with `422` and
`fields: ["_unknown"]`; any other failure raised before the handler ran is answered with `503`. Both
answers carry the same headers as every other refusal, echo nothing from the request and log nothing.
A failure inside the handler before it could answer is also answered with `503`.

Every response carries `Cache-Control: no-store`. Success: `200` with `proof`, `purpose`, `connectionId`,
`method`, `assurance`, `expiresAt`, `ttlSeconds`. Refusals: `401 SECURITY_ACTION_SESSION_REQUIRED`;
`403` `SECURITY_ACTION_PURPOSE_UNAVAILABLE`, `SECURITY_ACTION_METHOD_UNAVAILABLE` (`nextStep`),
`SECURITY_ACTION_HIGH_PRIVILEGE_SELF_SERVICE_DENIED`, `SECURITY_ACTION_ASSURANCE_INSUFFICIENT`,
`SECURITY_ACTION_CONNECTION_NOT_PERMITTED`, `SECURITY_ACTION_CREDENTIAL_REJECTED` (`nextStep`);
`409` `SECURITY_ACTION_ORG_CONTEXT_REQUIRED`, `SECURITY_ACTION_TARGET_CONFLICT`,
`SECURITY_ACTION_STATE_CHANGED`; `422 SECURITY_ACTION_INVALID_REQUEST` (`fields`);
`429 SECURITY_ACTION_RATE_LIMITED` (`retryAfter`, `nextStep`, and a `Retry-After` header);
`503 SECURITY_ACTION_UNAVAILABLE` / `SECURITY_ACTION_PROOF_UNAVAILABLE`. `details` holds closed-set
values only. The route is documented in `packages/openapi/src/paths/auth.yml`.

## Operations

Default off. Apply the migration and confirm it with `migrate.js --confirm
zzzz20261106120000_create_security_action_challenges` before the switch is turned on; deploying and
turning the switch on are separate decisions. Rollback: turn the switch off and restart; `down()` only
after the image rollback and only on an empty table. The switch is registered in
`scripts/ops/global-history-flag-manifest.mjs`.

## Tests and wiring

- `tests/unit/security-action-proof.test.ts`: tokens, session context, request schema, refusals that
  need no data, both transactions, error mapping, audit, consumption decisions and statement pins.
- `tests/unit/security-action-verify-route.test.ts`: status and detail mapping, no-store, no echo of the
  password, organization from the session only, position behind the gates, the error handler's
  answers (unparseable or oversized body, any other upstream failure, a response already sent) and the
  handler's last-resort `503`.
- `tests/unit/security-action-proof-inert.test.ts`: production binding refuses every purpose before any
  statement; table, importer and mount boundaries; CI wiring; OpenAPI source.
- `tests/unit/security-action-proof-flag.test.ts`, `tests/unit/security-action-challenges-migration.test.ts`.
- `tests/integration/security-action-proof.db.test.ts` against real Postgres: catalog, every CHECK, the
  foreign key, the partial unique index and the trigger; the guarded `down()`/`up()` round trip;
  issuance, invalidation and consumption; the failure limit across sessions and purposes; a
  repeatable-read-default pool; lock order under concurrency. Excluded from the no-DB runner and run as
  a whole file in the approval real-DB step of `plugin-tests.yml`.
