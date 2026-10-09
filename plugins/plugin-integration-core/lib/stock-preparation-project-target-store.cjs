'use strict'

// 一个项目一张备料表 — THE REGISTRY (S1 of ADR adr-stock-prep-project-sheets-20261008, §1).
//
// One row per (tenant, business project number): WHICH managed sheet is that project's 备料表. The
// row is the ONLY authority for "project number -> sheet"; every read and write route that the
// project-sheets switch governs resolves its target through it (stock-preparation-table-actions.cjs,
// the `resolveProjectTarget` overlay) and NEVER through the env `action.target` while the switch is
// on. The env target stays configured (its `sheetId` is what `normalizeTarget` requires, its
// `objectId` is the fourth condition of the apply write gate) but its CONTENT is not read.
//
// WHY A SQL TABLE AND NOT A MULTITABLE RECORD. The unique index arbitrates concurrency: two pullers
// creating the same project's sheet at the same moment resolve to ONE row at the database, and the
// loser gets 23505 which this store turns into a typed 409 — a records-layer "registry" would have
// no constraint and no transaction (ADR §1.1). Same reasoning and the same shape as migration 079
// (source binding) and 084 (handoff cursor).
//
// VALUES-FREE. Every column is a handle (tenant id, project number — the same navigation handle the
// audit trail carries in `project_id` — sheet id, object id, actor ids), a closed enum (`status`,
// `last_pull_outcome`, `last_pull_code`), a small integer or a server clock. The three O2(a)
// project-level columns (负责人 / 备注 / 计划完成) are free text BY DESIGN and are written only by the
// S3 project-fields route; nothing in S1 writes them, and nothing here reads them back into a
// refusal, an audit row or a log line.
//
// NO `origin` COLUMN (Q3): the old mixed sheet is never registered; every row names a sheet THIS
// plugin created. NO workspace dimension, as with 084.
//
// THE LIFECYCLE (S4, ADR §6, register R-38): `archive` and `restore` are the only two state
// transitions, and archiving REPLACES deletion (Q2): neither touches the sheet, its grants, its rows,
// the confirmation ledger or the handoff cursor — they change THIS row's `status` and its outcome
// columns, nothing else, so they need no host port at all. Each runs in ONE transaction under the
// same per-tenant advisory lock `create` takes, reads the row FOR UPDATE, refuses a transition whose
// precondition does not hold (typed 409, never a silent no-op), and writes with a compare-and-set
// `where` that repeats the precondition. Migration 087's CHECK ties `archived_at` to the status, so
// archive sets it and restore clears it in the same statement.

const crypto = require('node:crypto')

const PROJECT_TARGET_TABLE = 'integration_stock_prep_project_target'
// The two unique indexes migration 087 installs. The scope index is the one the create race lands on.
const SCOPE_CONSTRAINT = 'uniq_integration_stock_prep_project_target_scope'
const SHEET_CONSTRAINT = 'uniq_integration_stock_prep_project_target_sheet'

const PROJECT_TARGET_STATUSES = Object.freeze(['active', 'archived'])

// E1 (S1 fix round 1): the per-tenant advisory-lock key `create` takes before it counts. The cap
// (200 rows per tenant, archived included) used to be count-then-insert in two autocommit
// statements, so N concurrent creates that all counted 199 all inserted; a 199-row probe with three
// concurrent creates ended at 202. Under `pg_advisory_xact_lock` the count and the insert of one
// tenant run one at a time, and the lock is released with the transaction.
const PROJECT_TARGET_CREATE_LOCK_PREFIX = 'stock-prep-project-target:'

// S4: the three typed refusals of a lifecycle transition. ABSENT is the resolver's own code (the same
// fact, the same words); the other two are distinct so a client can say "someone already archived it"
// / "it is not archived" instead of a generic conflict.
const PROJECT_TARGET_ABSENT_CODE = 'STOCK_PREPARATION_PROJECT_ABSENT'
// S4 fix round 1: the resolver's own code for "archived" — the create replay answers it when the row
// flipped to archived after the route's first read.
const PROJECT_TARGET_ARCHIVED_CODE = 'STOCK_PREPARATION_PROJECT_ARCHIVED'
const PROJECT_TARGET_ALREADY_ARCHIVED_CODE = 'STOCK_PREPARATION_PROJECT_ALREADY_ARCHIVED'
const PROJECT_TARGET_NOT_ARCHIVED_CODE = 'STOCK_PREPARATION_PROJECT_NOT_ARCHIVED'

class StockPreparationProjectTargetStoreError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'StockPreparationProjectTargetStoreError'
    this.status = status
    this.code = code
    this.details = details
  }
}

// Postgres unique-violation routing, same idiom as the handoff and source-binding stores.
function isUniqueViolation(error, constraint) {
  return Boolean(error) && error.code === '23505' && (!constraint || error.constraint === constraint)
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function requiredString(value, field) {
  const normalized = optionalString(value)
  if (!normalized) {
    throw new StockPreparationProjectTargetStoreError(422, 'STOCK_PREPARATION_PROJECT_TARGET_SCOPE_INVALID', `${field} is required`, { field })
  }
  return normalized
}

function firstRow(result) {
  if (Array.isArray(result)) return result[0] || null
  if (result && Array.isArray(result.rows)) return result.rows[0] || null
  return null
}

function allRows(result) {
  if (Array.isArray(result)) return result
  if (result && Array.isArray(result.rows)) return result.rows
  return []
}

function isoOrNull(value) {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

/**
 * The public projection of a row. HANDLES AND ENUMS ONLY: the three free-text project-level columns
 * are deliberately NOT projected here — S3's project-fields route projects them on its own read, so
 * no S1 surface (the GET target, the list, the preflight) can carry them by accident.
 */
function rowToPublicTarget(row) {
  if (!row) return null
  return {
    tenantId: row.tenant_id,
    projectNo: row.project_no,
    sheetId: row.sheet_id,
    objectId: row.object_id,
    status: row.status,
    createdBy: row.created_by ?? null,
    createdAt: isoOrNull(row.created_at),
    archivedAt: isoOrNull(row.archived_at),
    restoredAt: isoOrNull(row.restored_at),
    updatedAt: isoOrNull(row.updated_at),
    lastPullAt: isoOrNull(row.last_pull_at),
    lastPullOutcome: row.last_pull_outcome ?? null,
    lastPullCode: row.last_pull_code ?? null,
    rowCount: row.row_count === null || row.row_count === undefined ? null : Number(row.row_count),
    activeRowCount: row.active_row_count === null || row.active_row_count === undefined ? null : Number(row.active_row_count),
    countsBounded: row.counts_bounded === null || row.counts_bounded === undefined ? null : Boolean(row.counts_bounded),
    countsAt: isoOrNull(row.counts_at),
  }
}

function createStockPreparationProjectTargetStore({ db, idGenerator = crypto.randomUUID, now = () => new Date() } = {}) {
  if (
    !db ||
    typeof db.selectOne !== 'function' ||
    typeof db.select !== 'function' ||
    typeof db.insertOne !== 'function' ||
    typeof db.countRows !== 'function' ||
    // E1: `transaction` is REQUIRED, not nice-to-have — `create` serializes its count and insert
    // under a per-tenant advisory lock, and a lock in autocommit guards nothing.
    typeof db.transaction !== 'function'
  ) {
    throw new Error('createStockPreparationProjectTargetStore: scoped db helper (selectOne + select + insertOne + countRows + transaction) is required')
  }

  function scope(input = {}) {
    return {
      tenantId: requiredString(input.tenantId, 'tenantId'),
      // Trimmed exactly as `normalizeActionParameters` trims it (table-actions.cjs), so the registry
      // key and the pull parameter can never differ by whitespace.
      projectNo: requiredString(input.projectNo, 'projectNo'),
    }
  }

  /** The registry row for this project, or null — `null` is a state (ABSENT), never an error. */
  async function get(input = {}) {
    const { tenantId, projectNo } = scope(input)
    return rowToPublicTarget(await db.selectOne(PROJECT_TARGET_TABLE, { tenant_id: tenantId, project_no: projectNo }))
  }

  /** Every row of this tenant (active and archived), oldest first. The 200-row cap counts both. */
  async function list(input = {}) {
    const tenantId = requiredString(input.tenantId, 'tenantId')
    const rows = allRows(await db.select(PROJECT_TARGET_TABLE, {
      where: { tenant_id: tenantId },
      orderBy: ['created_at', 'ASC'],
      limit: 1000,
    }))
    return rows.map(rowToPublicTarget)
  }

  /** Registered rows of this tenant, archived INCLUDED — an archived sheet is still a live sheet. */
  async function count(input = {}) {
    const tenantId = requiredString(input.tenantId, 'tenantId')
    return db.countRows(PROJECT_TARGET_TABLE, { tenant_id: tenantId })
  }

  /** The per-tenant cap `create` enforces under its lock: a positive integer, or null for no cap. */
  function normalizeCap(value) {
    if (value === undefined || value === null) return null
    if (!Number.isInteger(value) || value < 1) {
      throw new StockPreparationProjectTargetStoreError(422, 'STOCK_PREPARATION_PROJECT_TARGET_SCOPE_INVALID', 'maxPerTenant must be a positive integer', { field: 'maxPerTenant' })
    }
    return value
  }

  /**
   * Register a freshly provisioned sheet as this project's 备料表.
   *
   * THE UNIQUE INDEX IS THE ARBITER. Two pullers who both read ABSENT and both provision land here
   * together; the sheet id is deterministic (derived from (staging project, objectId)), so both
   * provisioned the SAME sheet and only the registry insert can disagree. The loser's 23505 becomes a
   * typed 409 `STOCK_PREPARATION_PROJECT_TARGET_EXISTS` rather than a second row — pinned by the
   * store suite with a db whose insert raises the violation, and by the real-DB suite with two
   * concurrent creates against PostgreSQL.
   *
   * THE CAP IS ENFORCED HERE, UNDER A LOCK (E1). `maxPerTenant` (the route passes the 200-row cap)
   * is checked inside ONE transaction that first takes the tenant's advisory lock, then counts, then
   * inserts — so two creates for DIFFERENT projects of a tenant sitting at the cap cannot both read
   * "one below" and both land. The route's own pre-count stays (it refuses before provisioning a
   * sheet); this one is the authority. Order pinned by the store suite: transaction → lock → count →
   * insert, all on the transaction handle.
   */
  async function create(input = {}) {
    const { tenantId, projectNo } = scope(input)
    const sheetId = requiredString(input.sheetId, 'sheetId')
    const objectId = requiredString(input.objectId, 'objectId')
    const createdBy = optionalString(input.createdBy)
    const maxPerTenant = normalizeCap(input.maxPerTenant)
    try {
      return await db.transaction(async (trx) => {
        if (!trx || typeof trx.advisoryXactLock !== 'function') {
          throw new Error('createStockPreparationProjectTargetStore: the transaction handle must expose advisoryXactLock')
        }
        await trx.advisoryXactLock(`${PROJECT_TARGET_CREATE_LOCK_PREFIX}${tenantId}`)
        if (maxPerTenant !== null) {
          const registered = await trx.countRows(PROJECT_TARGET_TABLE, { tenant_id: tenantId })
          if (registered >= maxPerTenant) {
            throw new StockPreparationProjectTargetStoreError(
              409,
              'STOCK_PREPARATION_PROJECT_TARGET_LIMIT',
              `this tenant already has ${maxPerTenant} registered stock-preparation project sheets (archived included)`,
              { limit: maxPerTenant },
            )
          }
        }
        const row = firstRow(await trx.insertOne(PROJECT_TARGET_TABLE, {
          id: idGenerator(),
          tenant_id: tenantId,
          project_no: projectNo,
          sheet_id: sheetId,
          object_id: objectId,
          status: 'active',
          created_by: createdBy,
        }))
        return rowToPublicTarget(row)
      })
    } catch (error) {
      if (isUniqueViolation(error, SCOPE_CONSTRAINT) || isUniqueViolation(error, SHEET_CONSTRAINT)) {
        throw new StockPreparationProjectTargetStoreError(
          409,
          'STOCK_PREPARATION_PROJECT_TARGET_EXISTS',
          'this project already has a registered stock-preparation sheet',
          { field: 'projectNo' },
        )
      }
      throw error
    }
  }

  /**
   * ONE lifecycle transition (S4). Order pinned by the store suite: transaction → the tenant's
   * advisory lock (the SAME key `create` takes) → the row FOR UPDATE → the precondition → the
   * compare-and-set update, all on the transaction handle.
   *
   * THE PRECONDITION IS THE GUARD. `from` is the only status this transition may start from; any
   * other status is the typed `conflictCode`, a missing row is ABSENT. The update's `where` repeats
   * `status: from`, so even a caller that somehow bypassed the read could not move a row out of a
   * state it did not start in — an empty RETURNING is the same typed refusal, never a silent success.
   *
   * THE CAP IS NOT RE-CHECKED (restore): the row already counts against the 200 — `count` includes
   * archived rows — so moving it back to active changes nothing the cap measures.
   */
  async function transition(input, { from, conflictCode, conflictMessage, set }) {
    const { tenantId, projectNo } = scope(input)
    const actorId = optionalString(input.actorId)
    const at = now()
    return db.transaction(async (trx) => {
      if (!trx || typeof trx.advisoryXactLock !== 'function' || typeof trx.selectOneForUpdate !== 'function' || typeof trx.updateRow !== 'function') {
        throw new Error('createStockPreparationProjectTargetStore: the transaction handle must expose advisoryXactLock, selectOneForUpdate and updateRow')
      }
      await trx.advisoryXactLock(`${PROJECT_TARGET_CREATE_LOCK_PREFIX}${tenantId}`)
      const key = { tenant_id: tenantId, project_no: projectNo }
      const current = await trx.selectOneForUpdate(PROJECT_TARGET_TABLE, key)
      if (!current) {
        throw new StockPreparationProjectTargetStoreError(409, PROJECT_TARGET_ABSENT_CODE, 'this project has no registered stock-preparation sheet', { field: 'projectNo' })
      }
      if (current.status !== from) {
        throw new StockPreparationProjectTargetStoreError(409, conflictCode, conflictMessage, { field: 'projectNo' })
      }
      const updated = firstRow(await trx.updateRow(PROJECT_TARGET_TABLE, set(at, actorId), { ...key, status: from }))
      if (!updated) {
        throw new StockPreparationProjectTargetStoreError(409, conflictCode, conflictMessage, { field: 'projectNo' })
      }
      return rowToPublicTarget(updated)
    })
  }

  /**
   * ARCHIVE (Q2: 归档代替删除). active → archived, `archived_at` / `archived_by` stamped. The sheet is
   * not this store's to touch and it does not: no soft delete, no rename, no grant change.
   */
  async function archive(input = {}) {
    return transition(input, {
      from: 'active',
      conflictCode: PROJECT_TARGET_ALREADY_ARCHIVED_CODE,
      conflictMessage: 'this project\'s stock-preparation sheet is already archived',
      set: (at, actorId) => ({ status: 'archived', archived_at: at, archived_by: actorId, updated_at: at }),
    })
  }

  /**
   * RESTORE. archived → active, `restored_at` / `restored_by` stamped. `archived_at` is cleared in
   * the same statement because migration 087's CHECK ties it to the status; `archived_by` keeps the
   * last archiver as a fact (the audit trail keeps every transition).
   */
  async function restore(input = {}) {
    return transition(input, {
      from: 'archived',
      conflictCode: PROJECT_TARGET_NOT_ARCHIVED_CODE,
      conflictMessage: 'this project\'s stock-preparation sheet is not archived',
      set: (at, actorId) => ({ status: 'active', archived_at: null, restored_at: at, restored_by: actorId, updated_at: at }),
    })
  }

  /**
   * S4 fix round 1 — THE CREATE REPLAY'S GUARD. The create route reads the row OUTSIDE any lock (it
   * must, to choose between the create and the replay leg), so an archive can commit between that
   * read and the replay's heal — which would then re-run the G1 grant (and audit it) and may
   * re-install packs onto an archived sheet. This runs `fn(row)` INSIDE one transaction that first
   * takes the SAME per-tenant advisory lock archive / restore / create take, reads the row FOR
   * UPDATE and refuses unless it is still ACTIVE (409 STOCK_PREPARATION_PROJECT_ARCHIVED; a row gone
   * is ABSENT). The lock is HELD while `fn` runs, so an archive that arrives during the heal waits for
   * it to finish instead of slipping in between the check and the writes. `fn`'s own host writes are
   * not part of this transaction (it only holds the lock); a throw from `fn` propagates.
   */
  async function withActiveRowLocked(input = {}, fn) {
    const { tenantId, projectNo } = scope(input)
    if (typeof fn !== 'function') {
      throw new Error('withActiveRowLocked: a callback is required')
    }
    return db.transaction(async (trx) => {
      if (!trx || typeof trx.advisoryXactLock !== 'function' || typeof trx.selectOneForUpdate !== 'function') {
        throw new Error('createStockPreparationProjectTargetStore: the transaction handle must expose advisoryXactLock and selectOneForUpdate')
      }
      await trx.advisoryXactLock(`${PROJECT_TARGET_CREATE_LOCK_PREFIX}${tenantId}`)
      const current = await trx.selectOneForUpdate(PROJECT_TARGET_TABLE, { tenant_id: tenantId, project_no: projectNo })
      if (!current) {
        throw new StockPreparationProjectTargetStoreError(409, PROJECT_TARGET_ABSENT_CODE, 'this project has no registered stock-preparation sheet', { field: 'projectNo' })
      }
      if (current.status !== 'active') {
        throw new StockPreparationProjectTargetStoreError(409, PROJECT_TARGET_ARCHIVED_CODE, 'this project\'s stock-preparation sheet was archived; restore it instead of creating a second one', { field: 'projectNo' })
      }
      return fn(rowToPublicTarget(current))
    })
  }

  return { get, list, count, create, archive, restore, withActiveRowLocked }
}

module.exports = {
  PROJECT_TARGET_TABLE,
  PROJECT_TARGET_STATUSES,
  PROJECT_TARGET_CREATE_LOCK_PREFIX,
  PROJECT_TARGET_ABSENT_CODE,
  PROJECT_TARGET_ARCHIVED_CODE,
  PROJECT_TARGET_ALREADY_ARCHIVED_CODE,
  PROJECT_TARGET_NOT_ARCHIVED_CODE,
  SCOPE_CONSTRAINT,
  SHEET_CONSTRAINT,
  StockPreparationProjectTargetStoreError,
  createStockPreparationProjectTargetStore,
  __internals: {
    rowToPublicTarget,
    isUniqueViolation,
  },
}
