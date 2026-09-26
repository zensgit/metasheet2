'use strict'

// ---------------------------------------------------------------------------
// External-system delete × pointer write — the LOCK PROTOCOL's writer half.
//
// THE HOLE THIS CLOSES (owner review of #5923, `docs/development/autonomous-run-20260921-outcome.md`
// "Q2/#5923（订正）"): `deleteExternalSystem` counted the pointer tables that name an external system
// (integration_pipelines, 079 stock-prep source bindings, 062 read-source configs, 073 sealed-export
// bindings) and then deleted, but count and DELETE were two autocommit statements with no row lock
// between them. A writer that committed its pointer after the count and before the DELETE left a
// dangling reference — and because these tables deliberately carry no foreign key, PostgreSQL did not
// refuse either side. Making the delete transactional is NOT enough on its own: a transaction with no
// lock still counts a snapshot the writer is free to invalidate. The WRITER must participate.
//
// THE PROTOCOL.
//   * Delete side (`lib/external-systems.cjs` deleteExternalSystem): ONE transaction whose FIRST
//     statement is `SELECT ... FOR UPDATE` on the external-system row, THEN the counts, THEN the
//     DELETE. FOR UPDATE conflicts with KEY SHARE, so the delete waits for any in-flight pointer
//     write to commit — and then COUNTS it and refuses 409.
//   * Writer side (this helper, called by every pointer-writing path INSIDE its own write
//     transaction, BEFORE it touches the pointer row): `SELECT ... FOR KEY SHARE` on the row the
//     pointer is about to name. KEY SHARE waits for an in-flight delete to commit; when it resumes,
//     the row is gone, the read returns null, and the writer refuses in ITS path's existing
//     values-free error shape without writing anything.
//   Both orderings are therefore closed by the database's lock manager, not by timing — AT READ
//   COMMITTED, where each statement takes a fresh snapshot after its lock wait, so the count sees
//   exactly the pointers that committed while it waited, and the writer's re-read sees exactly the
//   delete that committed while it waited.
//
// ISOLATION IS PINNED, NOT ASSUMED (#6076 independent verification, third round). Under REPEATABLE
// READ the transaction snapshot is taken at its FIRST statement — for the delete side that is the
// FOR UPDATE itself, i.e. BEFORE the lock wait. A writer that committed its pointer while the delete
// waited is then invisible to the counts that follow, the delete counts zero and removes the row:
// the writer-first interleaving DANGLES (proven on PostgreSQL 16 with
// `ALTER DATABASE ... SET default_transaction_isolation = 'repeatable read'`). The writer side under
// REPEATABLE READ does not dangle but refuses as a bare SQLSTATE 40001 instead of its own
// values-free shape. A bare `BEGIN` inherits whatever `default_transaction_isolation` the server,
// database, role or connection says, so "the deployment runs READ COMMITTED" is a configuration
// fact the code cannot see. Every transaction that takes part in this protocol therefore issues
// `SET TRANSACTION ISOLATION LEVEL READ COMMITTED` as its FIRST statement, through
// `pinLockProtocolIsolation` below (`lib/db.cjs` setTransactionIsolationLevel, a whitelisted
// fixed-literal method on the transaction handle only). Inherited level NOT read committed: a SET
// after any query fails 25001 and aborts, so a wrong-order participant never runs on at that level;
// inherited level already read committed: a late SET is a no-op (it ran at read committed anyway).
// Participants: `deleteExternalSystem`, 079 `set`, 062 `saveVersion` (mint), `upsertPipeline`, `instantiateTemplate`.
//   Why SET rather than READ-AND-REFUSE (`current_setting('transaction_isolation')` first, 409/500 on
//   anything but read committed): refusing keeps the protocol sound but turns a database whose
//   default is REPEATABLE READ / SERIALIZABLE into one where no external system can be deleted and
//   no pointer can be written at all; pinning makes the protocol hold on such a database with no
//   operator action, costs the same one round trip, and fails closed in the same situations
//   (method missing → refused before any statement; late at a non-RC default → 25001). The host transaction API
//   (`packages/core-backend/src/index.ts` context.api.database.transaction →
//   `src/integration/db/connection-pool.ts` transaction: `BEGIN`, then the callback) runs nothing
//   between BEGIN and the callback's first statement, so the SET can always be first.
//   What pinning cannot fix: a host whose `transaction` is not a real transaction block on ONE
//   connection. There PostgreSQL only WARNS on SET TRANSACTION — and the row locks are released at
//   statement end anyway, so the protocol is void for a reason isolation cannot address. That host
//   contract is a premise, recorded in the design doc.
//
// WHY KEY SHARE (see `lib/db.cjs` selectOneForKeyShare): it conflicts with FOR UPDATE / DELETE and
// with nothing weaker, so pointer writes never serialize against an ordinary non-key UPDATE of the
// same system (name, config, status — those take FOR NO KEY UPDATE), and two pointer writers never
// block each other. It is the exact lock PostgreSQL's own RI check takes on a referenced row.
//
// LOCK ORDER (global, acyclic): `data_sources` row → `integration_external_systems` row → pointer
// table rows. The delete side locks ONLY the external-system row and then only SELECT COUNTs the
// pointer tables (COUNT takes no row locks), so it never waits on a pointer-row lock while holding
// the system lock. Every writer locks the system row FIRST and its pointer row(s) SECOND. No path in
// the plugin locks a pointer row and then the system row — the one path that locks a pointer row
// (073 provisioning's FOR UPDATE on the ACTIVE binding) does not take the system lock at all today
// (see the design doc's residual). Two writers holding KEY SHARE on different systems and each
// wanting the other's row cannot deadlock either: KEY SHARE is compatible with KEY SHARE.
//
// SCOPE OF THE LOCK: `tenant_id` + `id`, no workspace filter — deliberately the same scope as the
// delete guard's dependent counts (`countDependentBindingReferences`). The pointer tables are tenant
// scoped and their readers resolve across workspace fallbacks, so the row a writer must pin is the
// tenant's row with that id, whichever workspace it lives in. `id` is the primary key, so this is at
// most one row, and it is the SAME physical row the delete side locks with its exact scope.
//
// NOT EVERY WRITER GOES THROUGH THIS HELPER. The 079 and 062 writers do. `pipelines.cjs`
// requireExternalSystem (pipelines and template instantiation) takes its KEY SHARE directly with the
// pipeline's OWN scope — `scopeWhere(normalized)` + id, i.e. tenant + workspace + id — which is the
// scope the delete side counts pipelines with (`countPipelineReferences`) and the pairing 057's real
// foreign key backs. A pipeline can only name a system in its own workspace: when that where misses,
// the write is refused before anything is written, so the row it pins is still the one physical row
// the delete locks, or none. (`__tests__/external-systems-delete-bind-lock-protocol.test.cjs` L-10
// pins the 079 shape, L-11 the pipeline shape.)
//
// WHAT THIS DOES NOT DO. It does not judge eligibility (kind / role / status) — each caller still
// runs its own eligibility check where it always did. It does not create the row lock outside a
// transaction (autocommit releases it at statement end, which is why every caller requires
// `transaction` and calls this on the TRANSACTION handle). It does not widen `lib/db.cjs`'s
// `integration_` table whitelist: `integration_external_systems` is already inside it.
// ---------------------------------------------------------------------------

const EXTERNAL_SYSTEMS_TABLE = 'integration_external_systems'
// The one isolation level every protocol participant pins (`lib/db.cjs` whitelist key).
const LOCK_PROTOCOL_ISOLATION_LEVEL = 'read committed'

function requiredText(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`lockExternalSystemForPointerWrite: ${field} is required`)
  }
  return value.trim()
}

/**
 * Take KEY SHARE on the external-system row a pointer is about to name, inside the caller's
 * transaction, and return that row — or `null` when no such row exists in this tenant (never
 * existed, or its delete committed while this lock waited; the two are deliberately not told
 * apart, so a caller cannot learn about another tenant's rows by timing).
 *
 * FAIL-CLOSED on a helper that cannot lock: an executor without `selectOneForKeyShare` is refused
 * with a thrown Error rather than degraded to a plain SELECT, because a plain SELECT is exactly the
 * unprotected read this protocol exists to replace.
 */
async function lockExternalSystemForPointerWrite(executor, { tenantId, id } = {}) {
  if (!executor || typeof executor.selectOneForKeyShare !== 'function') {
    throw new Error(
      'lockExternalSystemForPointerWrite: a transaction handle with selectOneForKeyShare is required (external-system delete lock protocol)',
    )
  }
  const scopedTenantId = requiredText(tenantId, 'tenantId')
  const scopedId = requiredText(id, 'id')
  return executor.selectOneForKeyShare(EXTERNAL_SYSTEMS_TABLE, {
    tenant_id: scopedTenantId,
    id: scopedId,
  })
}

/**
 * Pin the calling transaction to READ COMMITTED — the level the lock protocol is proven at. MUST be
 * the transaction's FIRST statement (issued late: 25001 + abort at a non-RC default, a no-op at RC —
 * see the file header). Call it on the TRANSACTION handle, before the FOR UPDATE (delete side) or the
 * KEY SHARE (writer side) and before anything else the transaction reads.
 *
 * FAIL-CLOSED on a handle that cannot pin: an executor without `setTransactionIsolationLevel` (a
 * root helper, an older host binding, a fake) is refused with a thrown Error rather than allowed to
 * run at whatever level it inherited, because an inherited REPEATABLE READ is exactly the
 * configuration under which the delete side's count misses a pointer that committed while it waited.
 */
async function pinLockProtocolIsolation(executor) {
  if (!executor || typeof executor.setTransactionIsolationLevel !== 'function') {
    throw new Error(
      'pinLockProtocolIsolation: a transaction handle with setTransactionIsolationLevel is required (external-system delete lock protocol)',
    )
  }
  await executor.setTransactionIsolationLevel(LOCK_PROTOCOL_ISOLATION_LEVEL)
}

module.exports = {
  EXTERNAL_SYSTEMS_TABLE,
  LOCK_PROTOCOL_ISOLATION_LEVEL,
  lockExternalSystemForPointerWrite,
  pinLockProtocolIsolation,
}
