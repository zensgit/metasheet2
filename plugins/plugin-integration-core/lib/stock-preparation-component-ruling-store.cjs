'use strict'

// Batch-refresh step 6d-1b (S6-5; step-6 design §6.5 / §7.3 as rebaselined 2026-11-09; register R-91) — THE COMPONENT
// RULING STORE over migration 107 (`integration_stock_prep_component_ruling`).
//
// What it holds: the admin's recorded acknowledgement that a doubled-sheet "item-10" remnant (design §6.1 D2) of ONE
// project is no longer separately ordered (`remnant_acknowledged`, basis `head_not_ordered`), and its revocation. The
// kind `dropped_head_included` is reserved for the conditional S6-7 (the migration's CHECK admits it; nothing here
// writes it, and readiness never lets it exempt a remnant until S6-7 says so).
//
// FAIL CLOSED. Every read answers rows or throws a typed 503 — never "no acknowledgement" for a failure. A database
// without 107 therefore makes readiness v5's remnant check `ok: false` (no enable) and the acknowledgement routes 503.
//
// ATOMIC WITH ITS AUDIT ROW. `recordRemnantAcknowledgement` and `revokeRemnantAcknowledgement` run ONE transaction: the
// row, then the caller's `auditWithin(trx, event)` on the same handle (exception_resolve, the D9 precedent). An audit
// failure rolls the row back; a row failure writes no audit row.
//
// VALUES. The component digest is the census handle (private, 24 hex); `runbookRef` is a values-free ticket handle.
// Nothing else but ids, closed tokens, principals and server clocks is stored.

const crypto = require('node:crypto')

const COMPONENT_RULING_TABLE = 'integration_stock_prep_component_ruling'
const COMPONENT_RULING_KINDS = Object.freeze(['remnant_acknowledged', 'dropped_head_included'])
const COMPONENT_RULING_STATUSES = Object.freeze(['active', 'revoked'])
const REMNANT_ACKNOWLEDGEMENT_BASES = Object.freeze(['head_not_ordered'])
const COMPONENT_DIGEST_PATTERN = /^[0-9a-f]{24}$/
const RUNBOOK_REF_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/
const RULING_ID_PATTERN = /^[A-Za-z0-9._:-]{1,80}$/
const ACTIVE_UNIQUE_INDEX = 'uniq_integration_stock_prep_component_ruling_active'
// A project holds a handful of D2 components; the ceiling only bounds a runaway read (past it: 503, never a partial list).
const RULING_READ_CEILING = 1000

const COMPONENT_RULING_ERROR_CODES = Object.freeze({
  STORE_UNAVAILABLE: 'STOCK_PREP_COMPONENT_RULING_STORE_UNAVAILABLE',
  STORE_FAILED: 'STOCK_PREP_COMPONENT_RULING_STORE_FAILED',
  INPUT_INVALID: 'STOCK_PREP_COMPONENT_RULING_INPUT_INVALID',
  ALREADY_ACKNOWLEDGED: 'STOCK_PREP_REMNANT_ALREADY_ACKNOWLEDGED',
  ACKNOWLEDGEMENT_NOT_FOUND: 'STOCK_PREP_REMNANT_ACKNOWLEDGEMENT_NOT_FOUND',
  ALREADY_REVOKED: 'STOCK_PREP_REMNANT_ACKNOWLEDGEMENT_ALREADY_REVOKED',
})

class StockPreparationComponentRulingError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'StockPreparationComponentRulingError'
    this.status = status
    this.code = code
    this.details = { ...details, partial: false }
  }
}

function nonBlankString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function allRows(result) {
  if (Array.isArray(result)) return result
  if (result && Array.isArray(result.rows)) return result.rows
  return []
}

function isoOrNull(value) {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

function sqlStateOf(error) {
  return error && typeof error.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : undefined
}

function inputInvalid(field) {
  return new StockPreparationComponentRulingError(500, COMPONENT_RULING_ERROR_CODES.INPUT_INVALID, 'the component ruling store was handed a malformed input', { field })
}

function storeFailed(operation, error) {
  // A typed refusal raised inside the transaction (the caller's audit hook included) passes through unchanged.
  if (error instanceof StockPreparationComponentRulingError) return error
  if (error && Number.isInteger(error.status) && error.status >= 400 && error.status < 600 && typeof error.code === 'string') return error
  const sqlState = sqlStateOf(error)
  return new StockPreparationComponentRulingError(503, COMPONENT_RULING_ERROR_CODES.STORE_FAILED, 'the component ruling ledger could not be read or written', {
    operation,
    ...(sqlState ? { sqlState } : {}),
    ...(sqlState === '42P01' ? { reason: 'undefined_table' } : {}),
  })
}

function normalizeScope(input = {}) {
  for (const field of ['tenantId', 'sheetId', 'projectNo']) {
    if (!nonBlankString(input[field])) throw inputInvalid(field)
  }
  return Object.freeze({ tenantId: input.tenantId.trim(), sheetId: input.sheetId.trim(), projectNo: input.projectNo.trim() })
}

function rowToRuling(row) {
  return Object.freeze({
    id: row.id,
    tenantId: row.tenant_id,
    sheetId: row.sheet_id,
    projectNo: row.project_no,
    componentDigest: row.component_digest,
    kind: row.kind,
    basis: row.basis ?? null,
    status: row.status,
    runbookRef: row.runbook_ref,
    recordedBy: row.recorded_by,
    recordedAt: isoOrNull(row.recorded_at),
    revokedBy: row.revoked_by ?? null,
    revokedAt: isoOrNull(row.revoked_at),
    revokedRunbookRef: row.revoked_runbook_ref ?? null,
  })
}

/** A row the store read must name the scope it was read for (a row of another scope is a store failure, never data). */
function assertScopedRow(row, scope, operation) {
  if (!row || row.tenant_id !== scope.tenantId || row.sheet_id !== scope.sheetId || row.project_no !== scope.projectNo) {
    throw new StockPreparationComponentRulingError(503, COMPONENT_RULING_ERROR_CODES.STORE_FAILED, 'the component ruling ledger answered a row outside the scope it was asked for', { operation, reason: 'scope_mismatch' })
  }
  if (!COMPONENT_RULING_KINDS.includes(row.kind) || !COMPONENT_RULING_STATUSES.includes(row.status) || !COMPONENT_DIGEST_PATTERN.test(String(row.component_digest))) {
    throw new StockPreparationComponentRulingError(503, COMPONENT_RULING_ERROR_CODES.STORE_FAILED, 'the component ruling ledger answered a malformed row', { operation, reason: 'row_malformed' })
  }
  return row
}

function createStockPreparationComponentRulingStore({ db, idGenerator = () => `cr_${crypto.randomUUID()}`, now = () => new Date() } = {}) {
  if (!db || typeof db.select !== 'function' || typeof db.transaction !== 'function') {
    throw new Error('createStockPreparationComponentRulingStore: scoped db helper (select + transaction) is required')
  }

  async function readScopeRows(executor, scope, operation, where = {}) {
    const rows = allRows(await executor.select(COMPONENT_RULING_TABLE, {
      where: { tenant_id: scope.tenantId, sheet_id: scope.sheetId, project_no: scope.projectNo, ...where },
      orderBy: ['recorded_at', 'ASC'],
      limit: RULING_READ_CEILING + 1,
    }))
    if (rows.length > RULING_READ_CEILING) {
      throw new StockPreparationComponentRulingError(503, COMPONENT_RULING_ERROR_CODES.STORE_FAILED, 'the component ruling ledger holds more rows for this project than one read may answer', { operation, reason: 'read_ceiling' })
    }
    return rows.map((row) => rowToRuling(assertScopedRow(row, scope, operation)))
  }

  /** The ACTIVE rulings of one project sheet (both kinds), oldest first. Throws 503 on any failure. */
  async function listActiveRulings(input = {}) {
    const scope = normalizeScope(input)
    try {
      return await readScopeRows(db, scope, 'list_active', { status: 'active' })
    } catch (error) {
      throw storeFailed('list_active', error)
    }
  }

  /** Every ruling of one project sheet (active and revoked), oldest first. Throws 503 on any failure. */
  async function listRulings(input = {}) {
    const scope = normalizeScope(input)
    try {
      return await readScopeRows(db, scope, 'list')
    } catch (error) {
      throw storeFailed('list', error)
    }
  }

  /**
   * RECORD ONE ACKNOWLEDGEMENT (kind remnant_acknowledged). The caller has re-proved the remnant on a fresh read; this
   * inserts the row and runs `auditWithin(trx, event)` on the same transaction. A second active acknowledgement of the
   * same component is the partial UNIQUE's 23505 => 409 ALREADY_ACKNOWLEDGED (nothing written, no audit row).
   */
  async function recordRemnantAcknowledgement(input = {}) {
    const scope = normalizeScope(input)
    if (typeof input.componentDigest !== 'string' || !COMPONENT_DIGEST_PATTERN.test(input.componentDigest)) throw inputInvalid('componentDigest')
    if (!REMNANT_ACKNOWLEDGEMENT_BASES.includes(input.basis)) throw inputInvalid('basis')
    if (typeof input.runbookRef !== 'string' || !RUNBOOK_REF_PATTERN.test(input.runbookRef)) throw inputInvalid('runbookRef')
    if (!nonBlankString(input.recordedBy)) throw inputInvalid('recordedBy')
    if (typeof input.auditWithin !== 'function') throw inputInvalid('auditWithin')
    const id = idGenerator()
    if (typeof id !== 'string' || !RULING_ID_PATTERN.test(id)) throw inputInvalid('id')
    const at = now()
    try {
      return await db.transaction(async (trx) => {
        let inserted
        try {
          inserted = allRows(await trx.insertOne(COMPONENT_RULING_TABLE, {
            id,
            tenant_id: scope.tenantId,
            sheet_id: scope.sheetId,
            project_no: scope.projectNo,
            component_digest: input.componentDigest,
            kind: 'remnant_acknowledged',
            basis: input.basis,
            rules: null,
            position_fingerprint: null,
            status: 'active',
            runbook_ref: input.runbookRef,
            recorded_by: input.recordedBy.trim(),
            recorded_at: at,
            revoked_by: null,
            revoked_at: null,
            revoked_runbook_ref: null,
            updated_at: at,
          }))
        } catch (error) {
          if (sqlStateOf(error) === '23505') {
            throw new StockPreparationComponentRulingError(409, COMPONENT_RULING_ERROR_CODES.ALREADY_ACKNOWLEDGED, 'this component already carries an active acknowledgement; nothing was recorded', { reason: 'active_acknowledgement_exists' })
          }
          throw error
        }
        const row = inserted[0] ? rowToRuling(assertScopedRow(inserted[0], scope, 'record')) : null
        if (!row || row.id !== id) {
          throw new StockPreparationComponentRulingError(503, COMPONENT_RULING_ERROR_CODES.STORE_FAILED, 'the acknowledgement insert answered no row', { operation: 'record', reason: 'insert_unconfirmed' })
        }
        await input.auditWithin(trx, Object.freeze({ operation: 'remnant_acknowledged', rulingId: row.id, kind: row.kind, basis: row.basis, runbookRef: row.runbookRef }))
        return row
      })
    } catch (error) {
      throw storeFailed('record', error)
    }
  }

  /**
   * REVOKE ONE ACKNOWLEDGEMENT. One transaction: the row FOR UPDATE by (id, scope) — absent or of another kind => 404;
   * already revoked => 409; then the compare-and-set update (status active -> revoked, with the revoker, the clock and
   * the revoke's own runbookRef) and the caller's `auditWithin(trx, event)`.
   */
  async function revokeRemnantAcknowledgement(input = {}) {
    const scope = normalizeScope(input)
    if (typeof input.rulingId !== 'string' || !RULING_ID_PATTERN.test(input.rulingId)) throw inputInvalid('rulingId')
    if (typeof input.runbookRef !== 'string' || !RUNBOOK_REF_PATTERN.test(input.runbookRef)) throw inputInvalid('runbookRef')
    if (!nonBlankString(input.revokedBy)) throw inputInvalid('revokedBy')
    if (typeof input.auditWithin !== 'function') throw inputInvalid('auditWithin')
    const at = now()
    try {
      return await db.transaction(async (trx) => {
        if (typeof trx.selectOneForUpdate !== 'function' || typeof trx.updateRow !== 'function') {
          throw new StockPreparationComponentRulingError(501, COMPONENT_RULING_ERROR_CODES.STORE_UNAVAILABLE, 'the transaction handle cannot lock and update a ruling row', { reason: 'transaction_handle' })
        }
        const found = await trx.selectOneForUpdate(COMPONENT_RULING_TABLE, {
          id: input.rulingId, tenant_id: scope.tenantId, sheet_id: scope.sheetId, project_no: scope.projectNo,
        })
        if (!found || found.kind !== 'remnant_acknowledged') {
          throw new StockPreparationComponentRulingError(404, COMPONENT_RULING_ERROR_CODES.ACKNOWLEDGEMENT_NOT_FOUND, 'this project has no such acknowledgement', { reason: 'not_found' })
        }
        assertScopedRow(found, scope, 'revoke')
        if (found.status !== 'active') {
          throw new StockPreparationComponentRulingError(409, COMPONENT_RULING_ERROR_CODES.ALREADY_REVOKED, 'this acknowledgement is already revoked; nothing was changed', { reason: 'already_revoked' })
        }
        const updated = allRows(await trx.updateRow(COMPONENT_RULING_TABLE, {
          status: 'revoked', revoked_by: input.revokedBy.trim(), revoked_at: at, revoked_runbook_ref: input.runbookRef, updated_at: at,
        }, {
          id: input.rulingId, tenant_id: scope.tenantId, sheet_id: scope.sheetId, project_no: scope.projectNo, status: 'active',
        }))
        if (updated.length !== 1) {
          throw new StockPreparationComponentRulingError(503, COMPONENT_RULING_ERROR_CODES.STORE_FAILED, 'the revoke did not move exactly one row', { operation: 'revoke', reason: 'update_unconfirmed' })
        }
        const row = rowToRuling(assertScopedRow(updated[0], scope, 'revoke'))
        await input.auditWithin(trx, Object.freeze({ operation: 'remnant_acknowledgement_revoked', rulingId: row.id, kind: row.kind, basis: row.basis, runbookRef: input.runbookRef }))
        return row
      })
    } catch (error) {
      throw storeFailed('revoke', error)
    }
  }

  return { listActiveRulings, listRulings, recordRemnantAcknowledgement, revokeRemnantAcknowledgement }
}

module.exports = {
  COMPONENT_RULING_TABLE,
  COMPONENT_RULING_KINDS,
  COMPONENT_RULING_STATUSES,
  COMPONENT_RULING_ERROR_CODES,
  REMNANT_ACKNOWLEDGEMENT_BASES,
  COMPONENT_DIGEST_PATTERN,
  RUNBOOK_REF_PATTERN,
  RULING_ID_PATTERN,
  ACTIVE_UNIQUE_INDEX,
  StockPreparationComponentRulingError,
  createStockPreparationComponentRulingStore,
}
