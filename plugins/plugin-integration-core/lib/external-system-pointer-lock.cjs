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
//   Both orderings are therefore closed by the database's lock manager, not by timing. READ
//   COMMITTED (the deployment's level) is sufficient: each statement takes a fresh snapshot after
//   its lock wait, so the count sees exactly the pointers that committed while it waited, and the
//   writer's re-read sees exactly the delete that committed while it waited.
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
// WHAT THIS DOES NOT DO. It does not judge eligibility (kind / role / status) — each caller still
// runs its own eligibility check where it always did. It does not create the row lock outside a
// transaction (autocommit releases it at statement end, which is why every caller requires
// `transaction` and calls this on the TRANSACTION handle). It does not widen `lib/db.cjs`'s
// `integration_` table whitelist: `integration_external_systems` is already inside it.
// ---------------------------------------------------------------------------

const EXTERNAL_SYSTEMS_TABLE = 'integration_external_systems'

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

module.exports = {
  EXTERNAL_SYSTEMS_TABLE,
  lockExternalSystemForPointerWrite,
}
