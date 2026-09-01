'use strict'

// 工作台里选源 — the DURABLE half. One row per (tenant, workspace, action) naming the external
// system the stock-preparation pull action reads from.
//
// WHY A TABLE AND NOT A CONFIG FILE. Its three sibling deploy-time surfaces (customer packs, the
// `ext_` field mapping, the B2a registry) are REVIEWED ARTIFACTS — objects a human authors, signs
// off and diffs, which is exactly why plugin-runtime-config.ts reads them off the deployment's own
// disk and refuses to let an env var carry them. This is the opposite kind of fact: a single
// foreign key into a table the same admin already manages from the same workbench, changed by
// clicking a name in a dropdown. Putting it in a file would mean the customer's admin still cannot
// change it — they have no shell — and that is the whole cost this line exists to remove.
//
// WHAT IT IS NOT. It is not a version ledger. read-source-config-store.cjs mints content-keyed
// versions and runs a draft->approved->retired lifecycle because a read CONFIG is a document whose
// history matters and whose runtime consumption must be gated on approval. A source binding is a
// POINTER: there is exactly one live answer, the previous answer has no readers, and a
// draft/approved split would mean an admin could "save" a binding that silently kept reading the
// old source — the precise confusion this change exists to end. The CHANGE is what is worth
// keeping, and that goes to the stock-prep audit trail (`source_binding_set`), which is append-only
// and already the place a reviewer looks.
//
// SCOPE. `(tenant_id, workspace_id, action_id)` — the same triple the action is resolved under, so
// two workspaces in one tenant can point at different PLMs and neither can read the other's
// pointer. `workspace_id` is NULLable and, exactly as migrations 057/062/066 do, its NULL is
// collapsed with COALESCE in the unique index rather than relying on PG14 NULLS NOT DISTINCT.
//
// VALUES-FREE. Every column is a handle: two scope ids, a frozen action id, an external-system row
// id, an actor id, and two server clocks. No credential, no host, no connection string, no customer
// business value can reach this table — the thing being stored is a reference to a row in
// integration_external_systems, which is itself where connection material is (encrypted) held.
//
// NO DELETE SURFACE. Unbinding is not modelled, deliberately: "no override" is the state a
// deployment starts in, and the fallback it degrades to is the env default. An admin who wants a
// different source picks a different source. A store that could clear a row would need its own
// audit action, its own confirmation and its own answer to "what does the action read now?", and
// none of those has a caller.

const crypto = require('node:crypto')

const BINDING_TABLE = 'integration_stock_prep_source_binding'

// The unique index from migration 079 — (tenant_id, COALESCE(workspace_id,''), action_id).
const SCOPE_CONSTRAINT = 'uniq_integration_stock_prep_source_binding_scope'
const MAX_SET_ATTEMPTS = 3

// Postgres unique-violation routing, same idiom as read-source-config-store.cjs.
function isUniqueViolation(error, constraint) {
  return Boolean(error) && error.code === '23505' && error.constraint === constraint
}

class StockPreparationSourceBindingStoreError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'StockPreparationSourceBindingStoreError'
    this.status = status
    this.code = code
    this.details = details
  }
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new StockPreparationSourceBindingStoreError(422, 'SOURCE_BINDING_SCOPE_INVALID', `${field} is required`, { field })
  }
  return value.trim()
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function scopeWhere({ tenantId, workspaceId, actionId }) {
  return {
    tenant_id: tenantId,
    workspace_id: workspaceId ?? null,
    action_id: actionId,
  }
}

function rowToPublicBinding(row) {
  if (!row) return null
  return {
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id ?? null,
    actionId: row.action_id,
    externalSystemId: row.external_system_id,
    updatedBy: row.updated_by ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  }
}

function firstRow(result) {
  if (Array.isArray(result)) return result[0] || null
  if (result && Array.isArray(result.rows)) return result.rows[0] || null
  return null
}

function createStockPreparationSourceBindingStore({ db, idGenerator = crypto.randomUUID } = {}) {
  if (
    !db ||
    typeof db.selectOne !== 'function' ||
    typeof db.insertOne !== 'function' ||
    typeof db.updateRow !== 'function' ||
    typeof db.transaction !== 'function'
  ) {
    // `transaction` is REQUIRED, not nice-to-have: read-then-write on a single row races, and the
    // caller needs the PREVIOUS value back to audit the change. Reading it in one statement and
    // writing in another would let a concurrent rebind make the audit trail name a source that was
    // never actually replaced.
    throw new Error('createStockPreparationSourceBindingStore: scoped db helper (incl. transaction) is required')
  }

  function normalizeScope(input = {}) {
    return {
      tenantId: requiredString(input.tenantId, 'tenantId'),
      workspaceId: optionalString(input.workspaceId),
      actionId: requiredString(input.actionId, 'actionId'),
    }
  }

  /** The persisted override, or `null` when this scope has never bound one. */
  async function get(input = {}) {
    const scope = normalizeScope(input)
    return rowToPublicBinding(await db.selectOne(BINDING_TABLE, scopeWhere(scope)))
  }

  /**
   * Bind (or rebind) this scope's source.
   *
   * Returns `{ binding, previousExternalSystemId, changed }` — the caller needs all three to write
   * the audit row, and they are produced INSIDE one transaction with the write so the "old" value
   * reported is provably the one this write replaced.
   *
   * Idempotent: rebinding to the same id still touches `updated_at`/`updated_by` (someone did
   * re-confirm it) and reports `changed: false`, so the audit trail can distinguish a real repoint
   * from a re-save without inventing a second action token.
   *
   * WHY A RETRY LOOP AND NOT A BARE UPSERT. `db.upsertOne` would make the write itself atomic, but
   * its `RETURNING *` yields the NEW row — and this caller's whole reason for existing is to report
   * the row it REPLACED, so the audit trail can say what the source used to be. Reading the old
   * value therefore has to happen, and a read-then-write is not made race-free by a transaction:
   * under READ COMMITTED two concurrent first-binds both see "absent" and the second INSERT dies on
   * the unique index. So the index is allowed to arbitrate and the loser RE-ENTERS with a fresh
   * transaction, where it now sees the winner's row and takes the UPDATE path — reporting the
   * winner's id as the previous one, which is the truth. Bounded, because an unbounded retry on a
   * violation we may have misdiagnosed is a spin.
   */
  async function set(input = {}) {
    const scope = normalizeScope(input)
    const externalSystemId = requiredString(input.externalSystemId, 'externalSystemId')
    const actor = optionalString(input.actor)
    const where = scopeWhere(scope)

    for (let attempt = 1; attempt <= MAX_SET_ATTEMPTS; attempt += 1) {
      try {
        return await db.transaction(async (trx) => {
          const existing = await trx.selectOne(BINDING_TABLE, where)
          const previousExternalSystemId = existing ? existing.external_system_id : null
          const row = existing
            ? firstRow(await trx.updateRow(
                BINDING_TABLE,
                { external_system_id: externalSystemId, updated_by: actor, updated_at: new Date() },
                where,
              ))
            : firstRow(await trx.insertOne(BINDING_TABLE, {
                id: idGenerator(),
                tenant_id: scope.tenantId,
                workspace_id: scope.workspaceId,
                action_id: scope.actionId,
                external_system_id: externalSystemId,
                updated_by: actor,
              }))
          if (!row) {
            // The row moved between the read and the write, or the helper returned nothing. Fail
            // CLOSED rather than reporting a binding we cannot prove landed — an admin told "saved"
            // whose source did not move is the worst outcome this surface has.
            throw new StockPreparationSourceBindingStoreError(409, 'SOURCE_BINDING_WRITE_CONFLICT', 'source binding write did not land', {
              actionId: scope.actionId,
            })
          }
          return {
            binding: rowToPublicBinding(row),
            previousExternalSystemId,
            changed: previousExternalSystemId !== externalSystemId,
          }
        })
      } catch (error) {
        // A 23505 aborts the PG transaction, so a retry must start a NEW one rather than continue
        // inside the aborted one — which is why the loop wraps `db.transaction` instead of sitting
        // inside it.
        if (isUniqueViolation(error, SCOPE_CONSTRAINT) && attempt < MAX_SET_ATTEMPTS) continue
        throw error
      }
    }
    throw new StockPreparationSourceBindingStoreError(409, 'SOURCE_BINDING_WRITE_CONFLICT', 'source binding write conflicted', {
      actionId: scope.actionId,
    })
  }

  return { get, set }
}

module.exports = {
  BINDING_TABLE,
  StockPreparationSourceBindingStoreError,
  createStockPreparationSourceBindingStore,
  __internals: {
    rowToPublicBinding,
    scopeWhere,
  },
}
