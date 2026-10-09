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

const crypto = require('node:crypto')

const PROJECT_TARGET_TABLE = 'integration_stock_prep_project_target'
// The two unique indexes migration 087 installs. The scope index is the one the create race lands on.
const SCOPE_CONSTRAINT = 'uniq_integration_stock_prep_project_target_scope'
const SHEET_CONSTRAINT = 'uniq_integration_stock_prep_project_target_sheet'

const PROJECT_TARGET_STATUSES = Object.freeze(['active', 'archived'])

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

function createStockPreparationProjectTargetStore({ db, idGenerator = crypto.randomUUID } = {}) {
  if (
    !db ||
    typeof db.selectOne !== 'function' ||
    typeof db.select !== 'function' ||
    typeof db.insertOne !== 'function' ||
    typeof db.countRows !== 'function'
  ) {
    throw new Error('createStockPreparationProjectTargetStore: scoped db helper (selectOne + select + insertOne + countRows) is required')
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

  /**
   * Register a freshly provisioned sheet as this project's 备料表.
   *
   * THE UNIQUE INDEX IS THE ARBITER. Two pullers who both read ABSENT and both provision land here
   * together; the sheet id is deterministic (derived from (staging project, objectId)), so both
   * provisioned the SAME sheet and only the registry insert can disagree. The loser's 23505 becomes a
   * typed 409 `STOCK_PREPARATION_PROJECT_TARGET_EXISTS` rather than a second row — pinned by the
   * store suite with a db whose insert raises the violation.
   */
  async function create(input = {}) {
    const { tenantId, projectNo } = scope(input)
    const sheetId = requiredString(input.sheetId, 'sheetId')
    const objectId = requiredString(input.objectId, 'objectId')
    const createdBy = optionalString(input.createdBy)
    try {
      const row = firstRow(await db.insertOne(PROJECT_TARGET_TABLE, {
        id: idGenerator(),
        tenant_id: tenantId,
        project_no: projectNo,
        sheet_id: sheetId,
        object_id: objectId,
        status: 'active',
        created_by: createdBy,
      }))
      return rowToPublicTarget(row)
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

  return { get, list, count, create }
}

module.exports = {
  PROJECT_TARGET_TABLE,
  PROJECT_TARGET_STATUSES,
  SCOPE_CONSTRAINT,
  SHEET_CONSTRAINT,
  StockPreparationProjectTargetStoreError,
  createStockPreparationProjectTargetStore,
  __internals: {
    rowToPublicTarget,
    isUniqueViolation,
  },
}
