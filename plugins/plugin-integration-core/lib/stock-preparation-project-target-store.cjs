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
const { sameSourceProject, SOURCE_PROJECT_COMPARISON_MODES } = require('./stock-preparation-source-value-semantics.cjs')
const { pinLockProtocolIsolation } = require('./external-system-pointer-lock.cjs')

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

// P2 (case-insensitive registration): under an effective readPlan `sourceProjectComparison:
// 'case-insensitive'`, a project number that differs from a registered one only by letter case is REFUSED at
// registration (never aliased, never rewritten), because both runtime paths would then be ambiguous. The
// refusals carry no project number. UNAVAILABLE is the fail-closed answer for a mode or a registry scan the
// store cannot trust; PREPARE_INVALID is a prepare callback that returned no usable handles.
const PROJECT_TARGET_IDENTITY_CONFLICT_CODE = 'STOCK_PREPARATION_PROJECT_IDENTITY_CONFLICT'
const PROJECT_TARGET_IDENTITY_UNAVAILABLE_CODE = 'STOCK_PREPARATION_PROJECT_IDENTITY_UNAVAILABLE'
const PROJECT_TARGET_BUSY_CODE = 'STOCK_PREPARATION_PROJECT_TARGET_BUSY'
// The transaction handle lacks the isolation / non-blocking lock capabilities the strict registration path needs.
const PROJECT_TARGET_LOCK_UNAVAILABLE_CODE = 'STOCK_PREPARATION_PROJECT_TARGET_LOCK_UNAVAILABLE'
const PROJECT_TARGET_PREPARE_INVALID_CODE = 'STOCK_PREPARATION_PROJECT_TARGET_PREPARE_INVALID'
// The same bound `list` reads with; a tenant above it cannot be scanned completely, so it fails closed.
const PROJECT_IDENTITY_MAX_ROWS = 1000

// S3 (ADR §5 O2(a), register R-37): THE THREE PROJECT-LEVEL COLUMNS, a CLOSED whitelist. These are
// the only free-text columns of the registry and `updateProjectFields` is the only writer; a fourth
// key is a 400 at the route and a throw here, never a silent extra column. Length caps bound what a
// cell may carry (the overview projects them into a sheet column, so they must stay cell-sized).
const PROJECT_FIELD_KEYS = Object.freeze(['responsibleLabel', 'note', 'plannedFinishOn'])
const PROJECT_FIELD_COLUMNS = Object.freeze({
  responsibleLabel: 'responsible_label',
  note: 'note',
  plannedFinishOn: 'planned_finish_on',
})
const PROJECT_FIELD_TEXT_LIMITS = Object.freeze({ responsibleLabel: 80, note: 500 })
const PROJECT_FIELDS_INVALID_CODE = 'STOCK_PREPARATION_PROJECT_FIELDS_INVALID'
// `planned_finish_on` is a DATE column: a calendar day, never a timestamp, never free text.
const PLANNED_FINISH_ON_PATTERN = /^\d{4}-\d{2}-\d{2}$/
// S3 fix round 1 (R13): the two free texts are single-line cell values. C0 / DEL / C1 control characters
// (NUL included) and the two Unicode line / paragraph separators are refused (typed 400, the field named,
// the value never echoed) — they would otherwise travel into a sheet cell, a CSV / xlsx export and a log
// viewer as invisible or line-breaking bytes.
const PROJECT_FIELD_CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/

// S3: the closed outcome enum the DB CHECK admits on `last_pull_outcome`, and the shape a
// `last_pull_code` must have (a closed error code — the same shape the pack-install wrapper admits —
// never a message, never a value).
//
// G1 field defect (R67): `failed` — an apply that RAN and wrote fewer rows than it planned (every row,
// or some, refused by the target: `counts.failed > 0`) is no longer stamped `applied`. Migration 087's
// CHECK admitted only the first three; the Kysely migration
// zzzz20261015090000_admit_stock_prep_project_target_failed_pull_outcome re-creates it with `failed`
// (its down() refuses while a `failed` row exists). Until that migration has run, a `failed` stamp is
// refused by the database and — like every stamp — logged and swallowed; the pull's answer stands.
const PROJECT_TARGET_PULL_OUTCOMES = Object.freeze(['applied', 'previewed', 'refused', 'failed'])
const PROJECT_TARGET_PULL_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/
// S3 fix round 1 (R10): what a refusal whose code does not have error-code shape is recorded as. The
// stamp never throws over a shape it was handed — it records this closed word instead (the route logs it).
const PROJECT_TARGET_PULL_CODE_UNKNOWN = 'UNKNOWN'

// S3 fix round 1 (R3 / R5): the per-tenant advisory-lock key every WRITE of the project overview takes —
// the full refresh and the per-event row update alike — so two writers of one tenant's overview never
// interleave their read-then-create. A key of its own (not the registry's create/archive key): the
// overview write makes host calls while it holds the lock, and registry transitions must not wait on it.
const PROJECT_OVERVIEW_LOCK_PREFIX = 'stock-prep-project-overview:'

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
    rowCount: intOrNull(row.row_count),
    activeRowCount: intOrNull(row.active_row_count),
    countsBounded: row.counts_bounded === null || row.counts_bounded === undefined ? null : Boolean(row.counts_bounded),
    // S3: the three remaining bounded counts the overview projects (ADR §1.2 / §5).
    missingComponentsCount: intOrNull(row.missing_components_count),
    procurementOpenCount: intOrNull(row.procurement_open_count),
    warehouseOpenCount: intOrNull(row.warehouse_open_count),
    countsAt: isoOrNull(row.counts_at),
  }
}

function intOrNull(value) {
  if (value === null || value === undefined) return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

/**
 * 备料分批拉取第一期 step 3 PR B (migration 101) — THE PILOT PROJECTION, kept APART from
 * `rowToPublicTarget` on purpose: the public target is what every S1–S4 surface answers and it must stay
 * byte-identical to what it answered before the pilot columns existed; the pilot state is read by the
 * lane gates, the readiness route and the step-4 governance consult, and by nothing else.
 *
 * COLUMN TOLERANCE (step-4 design §12): a row read on a database where migration 101 has NOT run carries
 * no `pilot_enabled_at` key at all (`SELECT *`), and that reads as NOT pilot — nothing could have been
 * enabled there. A read that FAILS is the caller's `unreadable` (the store throws; it never answers
 * "not pilot" for a failure). Handles, enums, a server clock and an integer only.
 */
function rowToPilotState(row) {
  if (!row) return null
  const enabledAt = row.pilot_enabled_at
  const pilot = enabledAt !== undefined && enabledAt !== null
  return {
    tenantId: row.tenant_id,
    projectNo: row.project_no,
    sheetId: row.sheet_id,
    objectId: row.object_id,
    status: row.status,
    pilot,
    pilotEnabledAt: pilot ? isoOrNull(enabledAt) : null,
    pilotEnabledBy: pilot ? (row.pilot_enabled_by ?? null) : null,
    pilotReadinessVersion: pilot ? intOrNull(row.pilot_readiness_version) : null,
  }
}

// PR B: the CAS of `markPilotEnabled` found the row moved between the FOR UPDATE read and the update —
// impossible under the per-tenant advisory lock, so it is a typed 409 rather than a silent retry.
const PROJECT_TARGET_PILOT_STATE_MOVED_CODE = 'STOCK_PREP_PILOT_STATE_MOVED'
// SQLSTATE 42P01 undefined_table: the ONE failure `probeTableReadable` reports by name (values-free).
const UNDEFINED_TABLE_SQLSTATE = '42P01'

/**
 * A DATE column as the calendar day it holds (`YYYY-MM-DD`), or null.
 *
 * S3 fix round 1 (R2): node-postgres parses a DATE as LOCAL midnight (`new Date(y, m - 1, d)`,
 * postgres-date), so the old `toISOString().slice(0, 10)` handed back the PREVIOUS day on every host east
 * of UTC (Asia/Shanghai: local midnight is 16:00Z the day before). The day is read from the LOCAL calendar
 * components — the exact inverse of that parse, in any process time zone — and never goes through UTC.
 * (The plugin's db helper is `SELECT *` only, so a `::text` projection is not available here; a host
 * whose driver hands DATE back as text takes the string branch.) Anything that is not a real calendar day
 * — `Infinity` for PostgreSQL's 'infinity', a malformed string — reads as null, never as a guess.
 */
function dayOrNull(value) {
  if (value === null || value === undefined) return null
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null
    const year = value.getFullYear()
    if (year < 1 || year > 9999) return null
    return `${String(year).padStart(4, '0')}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
  }
  const text = String(value)
  return PLANNED_FINISH_ON_PATTERN.test(text) ? text : null
}

/**
 * S3: THE ONE PROJECTION THAT CARRIES THE THREE PROJECT-LEVEL TEXTS (O2(a)). Read by the
 * project-fields routes and by the overview refresh — and by nothing else: `rowToPublicTarget`
 * above deliberately omits them, so no S1 / S4 surface (GET target, the list, a refusal, an audit
 * row) can carry a free-text value by accident.
 */
function rowToProjectFields(row) {
  if (!row) return null
  return {
    projectNo: row.project_no,
    status: row.status,
    sheetId: row.sheet_id,
    responsibleLabel: typeof row.responsible_label === 'string' && row.responsible_label ? row.responsible_label : null,
    note: typeof row.note === 'string' && row.note ? row.note : null,
    plannedFinishOn: dayOrNull(row.planned_finish_on),
    projectFieldsUpdatedBy: row.project_fields_updated_by ?? null,
    projectFieldsUpdatedAt: isoOrNull(row.project_fields_updated_at),
  }
}

/**
 * S3: normalize ONE project-fields patch against the closed whitelist. Returns the column set to
 * write (at least one key). Each value: a trimmed string within its cap, `null` (= clear), or — for
 * the date — a `YYYY-MM-DD` calendar day that really exists. An unknown key, an empty patch, an
 * over-long text or a malformed day is a typed 422 that names the FIELD and never echoes the value.
 */
function normalizeProjectFieldsPatch(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new StockPreparationProjectTargetStoreError(422, PROJECT_FIELDS_INVALID_CODE, 'project fields must be an object', { field: 'body' })
  }
  const set = {}
  const changed = []
  for (const key of Object.keys(input)) {
    if (!PROJECT_FIELD_KEYS.includes(key)) {
      throw new StockPreparationProjectTargetStoreError(422, PROJECT_FIELDS_INVALID_CODE, 'unknown project field', { field: key })
    }
  }
  for (const key of PROJECT_FIELD_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue
    const raw = input[key]
    let value = null
    if (raw !== null && raw !== undefined) {
      if (typeof raw !== 'string') {
        throw new StockPreparationProjectTargetStoreError(422, PROJECT_FIELDS_INVALID_CODE, 'project field must be a string or null', { field: key })
      }
      const trimmed = raw.trim()
      if (trimmed) {
        if (key === 'plannedFinishOn') {
          // S3 fix round 1 (R2): year 0000 is not a day PostgreSQL can store as given (there is no year 0
          // AD); the shape, the year floor and the round trip are checked BEFORE any IO.
          if (!PLANNED_FINISH_ON_PATTERN.test(trimmed) || Number(trimmed.slice(0, 4)) < 1 || Number.isNaN(Date.parse(`${trimmed}T00:00:00Z`)) || new Date(`${trimmed}T00:00:00Z`).toISOString().slice(0, 10) !== trimmed) {
            throw new StockPreparationProjectTargetStoreError(422, PROJECT_FIELDS_INVALID_CODE, 'plannedFinishOn must be a calendar day (YYYY-MM-DD) in year 0001 or later', { field: key })
          }
        } else if (PROJECT_FIELD_CONTROL_CHARACTER_PATTERN.test(raw)) {
          // S3 fix round 1 (R13): tested on the RAW value — a control character is refused even where
          // trimming would have removed it, so what the caller sent is what the rule judged.
          throw new StockPreparationProjectTargetStoreError(400, PROJECT_FIELDS_INVALID_CODE, 'project field must not contain control characters', { field: key, reason: 'control_character' })
        } else if (trimmed.length > PROJECT_FIELD_TEXT_LIMITS[key]) {
          throw new StockPreparationProjectTargetStoreError(422, PROJECT_FIELDS_INVALID_CODE, 'project field exceeds its length limit', { field: key, limit: PROJECT_FIELD_TEXT_LIMITS[key] })
        }
        value = trimmed
      }
    }
    set[PROJECT_FIELD_COLUMNS[key]] = value
    changed.push(key)
  }
  if (changed.length === 0) {
    throw new StockPreparationProjectTargetStoreError(422, PROJECT_FIELDS_INVALID_CODE, 'at least one project field is required', { field: 'body' })
  }
  return { set, changed }
}

/**
 * S3 fix round 1 (R10): a pull's refusal code as the registry may store it. Absent / blank → null; an
 * error-code-shaped string → itself; anything else (a message, an object, a code built from a value) → the
 * closed word UNKNOWN, with `mapped: true` so the caller can log that a shape was replaced. Pure.
 */
function normalizeProjectPullCode(value) {
  if (value === null || value === undefined) return { code: null, mapped: false }
  if (typeof value !== 'string') return { code: PROJECT_TARGET_PULL_CODE_UNKNOWN, mapped: true }
  const trimmed = value.trim()
  if (!trimmed) return { code: null, mapped: false }
  if (PROJECT_TARGET_PULL_CODE_PATTERN.test(trimmed)) return { code: trimmed, mapped: false }
  return { code: PROJECT_TARGET_PULL_CODE_UNKNOWN, mapped: true }
}

// P2 (case-insensitive identity): the fail-closed answer for a registry scan the store cannot trust.
function registryIdentityUnavailableError() {
  return new StockPreparationProjectTargetStoreError(
    503,
    PROJECT_TARGET_IDENTITY_UNAVAILABLE_CODE,
    'the project registry could not be checked for case-insensitive project identity, so nothing was changed',
    { field: 'projectNo' },
  )
}

/**
 * EVERY registry row of one tenant, archived included, read on the CALLER'S transaction for an identity
 * check: count, select, count. A count above the bound, an unstable count, a result that is not an array, or a
 * row that is not complete and canonical is the typed 503 — never an empty registry that would authorize a write.
 */
async function readRegistryRowsForIdentity(trx, tenantId) {
  try {
    if (!trx || typeof trx.countRows !== 'function' || typeof trx.select !== 'function') throw registryIdentityUnavailableError()
    const before = await trx.countRows(PROJECT_TARGET_TABLE, { tenant_id: tenantId })
    if (!Number.isSafeInteger(before) || before < 0 || before > PROJECT_IDENTITY_MAX_ROWS) throw registryIdentityUnavailableError()
    const selected = await trx.select(PROJECT_TARGET_TABLE, {
      where: { tenant_id: tenantId },
      orderBy: ['created_at', 'ASC'],
      limit: PROJECT_IDENTITY_MAX_ROWS,
    })
    // Do not use allRows here: its legacy fallback turns an invalid response into
    // an empty registry and would authorize a create when the count is also zero.
    const rows = Array.isArray(selected) ? selected : selected && selected.rows
    if (!Array.isArray(rows)) throw registryIdentityUnavailableError()
    const after = await trx.countRows(PROJECT_TARGET_TABLE, { tenant_id: tenantId })
    if (after !== before || rows.length !== before) throw registryIdentityUnavailableError()
    const canonical = (value) => typeof value === 'string' && value.length > 0 && value.trim() === value
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row) || row.tenant_id !== tenantId
        || !canonical(row.project_no) || !canonical(row.sheet_id) || !canonical(row.object_id)
        || !PROJECT_TARGET_STATUSES.includes(row.status)) {
        throw registryIdentityUnavailableError()
      }
    }
    return rows
  } catch (error) {
    if (error instanceof StockPreparationProjectTargetStoreError) throw error
    throw registryIdentityUnavailableError()
  }
}

/**
 * THE ACTIVATION HALF of the registration/activation serialization. A read-plan activation that makes the
 * tenant's project comparison case-insensitive calls this INSIDE its own transaction — after pinning READ
 * COMMITTED as that transaction's first statement, and BEFORE it locks any source, version or pointer row. It
 * takes the SAME per-tenant registry advisory lock every registration takes (blocking: an in-flight registration
 * finishes first), then counts the groups of registry rows whose project numbers fold together case-insensitively,
 * archived included. The lock is held until the activation commits, so a registration that runs next re-resolves
 * its comparison under that lock and sees the committed pointer. Returns the group count only; no project number
 * leaves this function.
 */
async function lockRegistryAndCountCaseFoldedProjectGroups(trx, tenantId) {
  const tenant = requiredString(tenantId, 'tenantId')
  if (!trx || typeof trx.advisoryXactLock !== 'function') throw registryIdentityUnavailableError()
  await trx.advisoryXactLock(`${PROJECT_TARGET_CREATE_LOCK_PREFIX}${tenant}`)
  const rows = await readRegistryRowsForIdentity(trx, tenant)
  try {
    let groups = 0
    const grouped = new Array(rows.length).fill(false)
    for (let i = 0; i < rows.length; i += 1) {
      if (grouped[i]) continue
      let members = 1
      for (let j = i + 1; j < rows.length; j += 1) {
        if (!grouped[j] && sameSourceProject(rows[i].project_no, rows[j].project_no, 'case-insensitive')) {
          grouped[j] = true
          members += 1
        }
      }
      if (members > 1) groups += 1
    }
    return groups
  } catch (_error) {
    throw registryIdentityUnavailableError()
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
   * The three ways a registry write takes the tenant's lock.
   * - 'try': the strict (case-insensitive) registration and replay. Pinned READ COMMITTED, then the
   *   NON-blocking lock: a contender gets BUSY instead of pinning a connection across another's provisioning.
   * - 'pinned': a default / case-sensitive registration that re-resolves its comparison under the lock. Pinned
   *   READ COMMITTED, then the ordinary BLOCKING lock (queues, never BUSY), so an activation or registration that
   *   committed while this one waited is visible to the re-resolution and to the scan.
   * - 'blocking': the old contract, for a caller that passes no resolver.
   */
  async function lockRegistration(trx, tenantId, mode) {
    if (mode === 'pinned') {
      if (!trx || typeof trx.setTransactionIsolationLevel !== 'function' || typeof trx.advisoryXactLock !== 'function') {
        throw new StockPreparationProjectTargetStoreError(503, PROJECT_TARGET_LOCK_UNAVAILABLE_CODE,
          'the project registry cannot take its registration lock here, so nothing was changed')
      }
      // First SQL, as on the strict path: under a REPEATABLE READ default the snapshot would be taken when the
      // lock statement STARTS, before the wait returns, and the post-lock scan would miss the last holder's row.
      await pinLockProtocolIsolation(trx)
      await trx.advisoryXactLock(`${PROJECT_TARGET_CREATE_LOCK_PREFIX}${tenantId}`)
      return
    }
    if (mode === 'try') {
      if (!trx || typeof trx.setTransactionIsolationLevel !== 'function' || typeof trx.tryAdvisoryXactLock !== 'function') {
        throw new StockPreparationProjectTargetStoreError(503, PROJECT_TARGET_LOCK_UNAVAILABLE_CODE,
          'the project registry cannot take its non-blocking registration lock here, so nothing was changed')
      }
      // First SQL: the post-lock scan must see committed rows even if the role's
      // default is REPEATABLE READ. Host callbacks need additional pool connections;
      // waiters must not hold every connection while waiting for this lock.
      await pinLockProtocolIsolation(trx)
      if (await trx.tryAdvisoryXactLock(`${PROJECT_TARGET_CREATE_LOCK_PREFIX}${tenantId}`) !== true) {
        throw new StockPreparationProjectTargetStoreError(409, PROJECT_TARGET_BUSY_CODE,
          'another project registration is in progress; retry after it finishes')
      }
      return
    }
    if (!trx || typeof trx.advisoryXactLock !== 'function') {
      throw new Error('createStockPreparationProjectTargetStore: the transaction handle must expose advisoryXactLock')
    }
    await trx.advisoryXactLock(`${PROJECT_TARGET_CREATE_LOCK_PREFIX}${tenantId}`)
  }

  /** The optional trusted mode resolver: absent, or a function. Anything else is a typed 422 before any IO. */
  function optionalModeResolver(value) {
    if (value !== undefined && typeof value !== 'function') {
      throw new StockPreparationProjectTargetStoreError(422, 'STOCK_PREPARATION_PROJECT_TARGET_SCOPE_INVALID', 'resolveSourceProjectComparison must be a function', { field: 'resolveSourceProjectComparison' })
    }
    return value
  }

  /** What a prepare callback returned, as the two handles the row stores; anything else fails closed. */
  function normalizePreparedTarget(value) {
    const sheetId = value && typeof value === 'object' ? optionalString(value.sheetId) : null
    const objectId = value && typeof value === 'object' ? optionalString(value.objectId) : null
    if (!sheetId || !objectId) {
      throw new StockPreparationProjectTargetStoreError(503, PROJECT_TARGET_PREPARE_INVALID_CODE, 'the prepared project sheet did not return usable handles, so nothing was registered', { field: 'sheetId' })
    }
    return { sheetId, objectId }
  }

  /**
   * THE ONE IDENTITY GUARD (P2), shared by `create` and `withActiveRowLocked` so the two cannot diverge. It
   * runs on the transaction handle AFTER the tenant advisory lock is held. The mode comes from the caller's
   * trusted async resolver (a resolver failure propagates untouched); the mode is therefore re-evaluated
   * under the registry lock on every call. `undefined` / 'case-sensitive' allow everything. 'case-insensitive'
   * scans EVERY row of the tenant, archived included, and refuses (409, no values) a row whose project number
   * differs exactly but matches case-insensitively. An unknown mode, a count above the bound, an unstable
   * count or an incomplete row is a typed 503. Without a resolver the guard does nothing (the old contract).
   *
   * F2: the resolver is handed THIS transaction (`{ executor: trx }`) and reads on it. The lock is held here, and
   * every BLOCKING taker of the same lock (a 'pinned' registration, archive / restore, a case-insensitive
   * activation) holds a pooled connection while it waits — so a comparison read that needed another pool
   * connection could wait behind them until the pool's connect timeout and refuse a registration nothing was
   * wrong with. Not closed by this: `prepareTarget` and a replay / repair callback still use the pool under the lock.
   */
  async function assertSourceProjectIdentity(trx, { tenantId, projectNo, resolveSourceProjectComparison }) {
    if (typeof resolveSourceProjectComparison !== 'function') return
    const mode = await resolveSourceProjectComparison({ executor: trx })
    if (mode !== undefined && !SOURCE_PROJECT_COMPARISON_MODES.includes(mode)) throw registryIdentityUnavailableError()
    if (mode !== 'case-insensitive') return
    const rows = await readRegistryRowsForIdentity(trx, tenantId)
    let conflict = false
    try {
      conflict = rows.some((row) => row.project_no !== projectNo && sameSourceProject(row.project_no, projectNo, 'case-insensitive'))
    } catch (_error) {
      throw registryIdentityUnavailableError()
    }
    if (conflict) {
      throw new StockPreparationProjectTargetStoreError(
        409,
        PROJECT_TARGET_IDENTITY_CONFLICT_CODE,
        'this tenant already has a stock-preparation project whose number differs only by letter case, so it cannot be registered while case-insensitive source matching is in effect',
        { field: 'projectNo' },
      )
    }
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
  async function create(input = {}, prepareTarget) {
    const { tenantId, projectNo } = scope(input)
    // P2: with the OPTIONAL `prepareTarget` callback (used only by the real create route) the handles are not
    // known up front: the callback provisions them INSIDE the transaction, after the lock, the identity guard,
    // the exact-row precheck and the cap. Its host writes are NOT rolled back with this transaction, and it
    // must not call back into a store method that takes the same tenant lock. Without it, the old
    // direct-handle contract is unchanged — except that a resolver passed WITHOUT `prepareTarget` (the default /
    // case-sensitive route leg, whose sheet is already provisioned) re-resolves the comparison under the
    // BLOCKING lock: a case-insensitive activation that committed after the route's pre-read is honoured here.
    const deferred = prepareTarget !== undefined
    if (deferred && typeof prepareTarget !== 'function') {
      throw new StockPreparationProjectTargetStoreError(422, 'STOCK_PREPARATION_PROJECT_TARGET_SCOPE_INVALID', 'prepareTarget must be a function', { field: 'prepareTarget' })
    }
    const resolveSourceProjectComparison = optionalModeResolver(input.resolveSourceProjectComparison)
    if (deferred && resolveSourceProjectComparison === undefined) {
      throw new StockPreparationProjectTargetStoreError(422, 'STOCK_PREPARATION_PROJECT_TARGET_SCOPE_INVALID', 'resolveSourceProjectComparison is required with prepareTarget', { field: 'resolveSourceProjectComparison' })
    }
    const sheetId = deferred ? null : requiredString(input.sheetId, 'sheetId')
    const objectId = deferred ? null : requiredString(input.objectId, 'objectId')
    const createdBy = optionalString(input.createdBy)
    const maxPerTenant = normalizeCap(input.maxPerTenant)
    try {
      return await db.transaction(async (trx) => {
        await lockRegistration(trx, tenantId, deferred ? 'try' : (resolveSourceProjectComparison ? 'pinned' : 'blocking'))
        if (deferred && typeof trx.selectOneForUpdate !== 'function') {
          throw new Error('createStockPreparationProjectTargetStore: the transaction handle must expose selectOneForUpdate')
        }
        await assertSourceProjectIdentity(trx, { tenantId, projectNo, resolveSourceProjectComparison })
        if (deferred) {
          const current = await trx.selectOneForUpdate(PROJECT_TARGET_TABLE, { tenant_id: tenantId, project_no: projectNo })
          if (current && current.status === 'archived') {
            throw new StockPreparationProjectTargetStoreError(409, PROJECT_TARGET_ARCHIVED_CODE, 'this project\'s stock-preparation sheet is archived; restore it instead of creating a second one', { field: 'projectNo' })
          }
          if (current) {
            throw new StockPreparationProjectTargetStoreError(409, 'STOCK_PREPARATION_PROJECT_TARGET_EXISTS', 'this project already has a registered stock-preparation sheet', { field: 'projectNo' })
          }
        }
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
        // Only now — lock held, identity clear, row absent, below the cap — is the sheet prepared.
        const target = deferred ? normalizePreparedTarget(await prepareTarget()) : { sheetId, objectId }
        const row = firstRow(await trx.insertOne(PROJECT_TARGET_TABLE, {
          id: idGenerator(),
          tenant_id: tenantId,
          project_no: projectNo,
          sheet_id: target.sheetId,
          object_id: target.objectId,
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
    // P2: optional trusted mode resolver; when given, the SAME identity guard `create` runs is applied after
    // the lock and before the row read and `fn`, in this one transaction.
    const resolveSourceProjectComparison = optionalModeResolver(input.resolveSourceProjectComparison)
    return db.transaction(async (trx) => {
      if (!trx || typeof trx.selectOneForUpdate !== 'function') {
        throw new Error('createStockPreparationProjectTargetStore: the transaction handle must expose selectOneForUpdate')
      }
      await lockRegistration(trx, tenantId, resolveSourceProjectComparison ? 'try' : 'blocking')
      await assertSourceProjectIdentity(trx, { tenantId, projectNo, resolveSourceProjectComparison })
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

  /**
   * S3 (ADR §5 O2(a); register R-37): WRITE THE PROJECT-LEVEL COLUMNS. The ONLY writer of the three
   * free-text columns. Same discipline as a lifecycle transition: one transaction, the SAME per-tenant
   * advisory lock, the row FOR UPDATE, then the precondition — an absent row is ABSENT, an ARCHIVED
   * row is 409 STOCK_PREPARATION_PROJECT_ARCHIVED (ADR §6 route table: 「项目级列修改 | 同一个 409」)
   * — then a compare-and-set update whose `where` repeats `status: 'active'`. Returns the project
   * fields projection and WHICH keys changed (names only; the route audits the names, never a value).
   */
  async function updateProjectFields(input = {}) {
    const { tenantId, projectNo } = scope(input)
    const actorId = optionalString(input.actorId)
    const { set, changed } = normalizeProjectFieldsPatch(input.fields)
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
      if (current.status !== 'active') {
        throw new StockPreparationProjectTargetStoreError(409, PROJECT_TARGET_ARCHIVED_CODE, 'this project\'s stock-preparation sheet is archived; restore it before changing its project-level fields', { field: 'projectNo' })
      }
      const updated = firstRow(await trx.updateRow(
        PROJECT_TARGET_TABLE,
        { ...set, project_fields_updated_by: actorId, project_fields_updated_at: at, updated_at: at },
        { ...key, status: 'active' },
      ))
      if (!updated) {
        throw new StockPreparationProjectTargetStoreError(409, PROJECT_TARGET_ARCHIVED_CODE, 'this project\'s stock-preparation sheet is archived; restore it before changing its project-level fields', { field: 'projectNo' })
      }
      return { fields: rowToProjectFields(updated), changed }
    })
  }

  /** S3: the project-level columns of ONE row (null when absent). The only read that carries them. */
  async function getProjectFields(input = {}) {
    const { tenantId, projectNo } = scope(input)
    return rowToProjectFields(await db.selectOne(PROJECT_TARGET_TABLE, { tenant_id: tenantId, project_no: projectNo }))
  }

  /** S3: the project-level columns of EVERY row of the tenant, keyed by project number (the overview refresh). */
  async function listProjectFields(input = {}) {
    const tenantId = requiredString(input.tenantId, 'tenantId')
    const rows = allRows(await db.select(PROJECT_TARGET_TABLE, {
      where: { tenant_id: tenantId },
      orderBy: ['created_at', 'ASC'],
      limit: 1000,
    }))
    const out = new Map()
    for (const row of rows) {
      const fields = rowToProjectFields(row)
      if (fields) out.set(fields.projectNo, fields)
    }
    return out
  }

  /**
   * S3 (ADR §1.2 `last_pull_*`): stamp the outcome of ONE pull (dry-run = previewed, apply = applied,
   * a typed refusal = refused + its code; R67: an apply whose target refused rows = failed + the
   * dominant row error code). A bare UPDATE keyed by (tenant, project) — the last pull
   * wins, no lock needed, no precondition: an archived row may legitimately record the refusal that
   * archiving caused. `missingComponentsCount`, when given, is the run's distinct count (the board's
   * number). Values-free by shape: the outcome is a closed enum, the code must have error-code shape.
   * Returns whether a row was stamped (false = no registry row; never a throw for that).
   */
  async function recordPullOutcome(input = {}) {
    const { tenantId, projectNo } = scope(input)
    if (typeof db.updateRow !== 'function') return false
    const outcome = input.outcome
    // S3 fix round 1 (R10): a stamp is a by-product of a pull that already happened; it never throws over
    // the SHAPE it was handed. An outcome outside the closed enum stamps nothing (false); a code that does
    // not have error-code shape is recorded as the closed word UNKNOWN (`normalizeProjectPullCode`; the
    // route logs that it happened, values-free).
    if (!PROJECT_TARGET_PULL_OUTCOMES.includes(outcome)) return false
    const code = normalizeProjectPullCode(input.code).code
    const at = input.at instanceof Date ? input.at : now()
    const set = { last_pull_at: at, last_pull_outcome: outcome, last_pull_code: code, updated_at: at }
    if (Number.isInteger(input.missingComponentsCount) && input.missingComponentsCount >= 0) {
      set.missing_components_count = input.missingComponentsCount
    }
    const rows = allRows(await db.updateRow(PROJECT_TARGET_TABLE, set, { tenant_id: tenantId, project_no: projectNo }))
    return rows.length > 0
  }

  /**
   * S3 (ADR §5 「截至」): stamp the BOUNDED counts of ONE project's sheet, as the overview refresh
   * measured them. Integers ≥ 0 (or null = not counted), `countsBounded` says whether they are a
   * floor, `countsAt` is the server clock of the measurement. Keyed by (tenant, project), no lock —
   * a refresh racing another refresh writes the same facts twice.
   */
  async function recordCounts(input = {}) {
    const { tenantId, projectNo } = scope(input)
    if (typeof db.updateRow !== 'function') return false
    const count = (value, field) => {
      if (value === null || value === undefined) return null
      if (!Number.isInteger(value) || value < 0) {
        throw new StockPreparationProjectTargetStoreError(422, 'STOCK_PREPARATION_PROJECT_TARGET_SCOPE_INVALID', `${field} must be a non-negative integer`, { field })
      }
      return value
    }
    const at = input.countsAt instanceof Date ? input.countsAt : now()
    const set = {
      row_count: count(input.rowCount, 'rowCount'),
      active_row_count: count(input.activeRowCount, 'activeRowCount'),
      counts_bounded: input.countsBounded === true,
      procurement_open_count: count(input.procurementOpenCount, 'procurementOpenCount'),
      warehouse_open_count: count(input.warehouseOpenCount, 'warehouseOpenCount'),
      counts_at: at,
      updated_at: at,
    }
    if (input.missingComponentsCount !== undefined) set.missing_components_count = count(input.missingComponentsCount, 'missingComponentsCount')
    const rows = allRows(await db.updateRow(PROJECT_TARGET_TABLE, set, { tenant_id: tenantId, project_no: projectNo }))
    return rows.length > 0
  }

  /**
   * S3 fix round 1 (R3 / R5), fix round 2 (F4): run `fn` holding the tenant's OVERVIEW advisory lock
   * (`PROJECT_OVERVIEW_LOCK_PREFIX`) — IF it is free. One transaction that only holds the lock (`fn`'s own host
   * calls are not part of it); every writer of the overview (the refresh, the per-event row update) runs inside
   * this, so two of them for one tenant never interleave a read-then-create and leave two rows for one project.
   *
   * IT NEVER WAITS (F4). The holder's `fn` needs MORE pool connections for its host calls, so a writer that
   * BLOCKED on the lock while holding its own pooled connection could, N times over, starve the holder it waits
   * for. `pg_try_advisory_xact_lock` answers at once: busy → `{ acquired: false }` and the transaction ends
   * (connection released) without calling `fn`; free → `{ acquired: true, value: await fn() }`, released when
   * `fn` settles. What a busy writer does instead is the caller's (stock-preparation-project-overview.cjs).
   */
  async function tryWithOverviewLock(input = {}, fn) {
    const tenantId = requiredString(input.tenantId, 'tenantId')
    if (typeof fn !== 'function') {
      throw new Error('tryWithOverviewLock: a callback is required')
    }
    return db.transaction(async (trx) => {
      if (!trx || typeof trx.tryAdvisoryXactLock !== 'function') {
        throw new Error('createStockPreparationProjectTargetStore: the transaction handle must expose tryAdvisoryXactLock')
      }
      const acquired = await trx.tryAdvisoryXactLock(`${PROJECT_OVERVIEW_LOCK_PREFIX}${tenantId}`)
      if (acquired !== true) return { acquired: false }
      return { acquired: true, value: await fn() }
    })
  }

  // ── 备料分批拉取第一期 step 3 PR B (migration 101): the pilot marker ──────────────────────────────

  /**
   * The handle a pilot read runs ON. `options.executor` (optional) is a scoped-db TRANSACTION handle of the
   * caller's: the step-4 governance consult passes its REPEATABLE READ snapshot handle so the registry row and
   * the step-4 rows it is compared with come from ONE snapshot (stock-preparation-continuation-store.cjs
   * readGovernanceRows, #6514 review X-1). Absent => this store's own db, exactly as before. A handle that
   * cannot read is refused (a throw is the caller's unreadable, never "not pilot").
   */
  function pilotReadHandle(options) {
    const executor = options && typeof options === 'object' ? options.executor : undefined
    if (executor === undefined || executor === null) return db
    if (typeof executor.selectOne !== 'function') {
      throw new Error('createStockPreparationProjectTargetStore: a pilot read executor must expose selectOne')
    }
    return executor
  }

  /** The pilot state of ONE project, by (tenant, project). `null` is ABSENT; a throw is the caller's unreadable. */
  async function getPilotState(input = {}, options = {}) {
    const { tenantId, projectNo } = scope(input)
    return rowToPilotState(await pilotReadHandle(options).selectOne(PROJECT_TARGET_TABLE, { tenant_id: tenantId, project_no: projectNo }))
  }

  /**
   * The pilot state of the project registered on ONE sheet — the lane gates' read: a large-BOM job and a
   * chunk carry the SHEET they write, and migration 087's unique index makes "sheet -> row" one row. Not
   * tenant-scoped on purpose (sheet ids are globally unique; the caller compares `tenantId` if it must);
   * a refusal derived from it is values-free, so no tenant learns anything it could not already see.
   */
  async function getPilotStateBySheetId(input = {}, options = {}) {
    const sheetId = requiredString(input.sheetId, 'sheetId')
    return rowToPilotState(await pilotReadHandle(options).selectOne(PROJECT_TARGET_TABLE, { sheet_id: sheetId }))
  }

  /**
   * MARK ONE PROJECT PILOT — set-once. Same discipline as a lifecycle transition: one transaction, the
   * SAME per-tenant advisory lock `create` / `archive` / `restore` take, the row FOR UPDATE, then the
   * preconditions — an absent row is ABSENT, an ARCHIVED row is 409 STOCK_PREPARATION_PROJECT_ARCHIVED
   * (a pilot is a live sheet), a row ALREADY pilot answers `{ enabled: false, alreadyEnabled: true }` with
   * the ORIGINAL stamp (a re-POST repairs the host stamp and writes nothing here, no second audit row) —
   * then ONE compare-and-set update whose `where` repeats `status: 'active'` AND `pilot_enabled_at IS NULL`,
   * so even a caller that bypassed the read could not move a row that is not active-and-unmarked. All
   * three columns land in the same statement (migration 101's CHECK ties the stamp to its version).
   * There is NO unset counterpart (R-53 ②).
   *
   * Pre-enable hardening F-4(c) (step-4 design §23.4): `onMarked(trx, { pilot })`, when given, runs INSIDE
   * this transaction right after the compare-and-set landed — and ONLY then (never on alreadyEnabled) — so
   * the caller's audit row commits or rolls back with the mark itself. A throw from it rolls the mark back.
   */
  async function markPilotEnabled(input = {}) {
    const { tenantId, projectNo } = scope(input)
    const actorId = optionalString(input.actorId)
    const readinessVersion = input.readinessVersion
    if (!Number.isInteger(readinessVersion) || readinessVersion < 1) {
      throw new StockPreparationProjectTargetStoreError(422, 'STOCK_PREPARATION_PROJECT_TARGET_SCOPE_INVALID', 'readinessVersion must be a positive integer', { field: 'readinessVersion' })
    }
    const onMarked = input.onMarked === undefined ? null : input.onMarked
    if (onMarked !== null && typeof onMarked !== 'function') {
      throw new StockPreparationProjectTargetStoreError(422, 'STOCK_PREPARATION_PROJECT_TARGET_SCOPE_INVALID', 'onMarked must be a function', { field: 'onMarked' })
    }
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
      if (current.status !== 'active') {
        throw new StockPreparationProjectTargetStoreError(409, PROJECT_TARGET_ARCHIVED_CODE, 'this project\'s stock-preparation sheet is archived; restore it before enabling the pilot', { field: 'projectNo' })
      }
      const already = rowToPilotState(current)
      if (already.pilot) return { enabled: false, alreadyEnabled: true, pilot: already }
      const updated = firstRow(await trx.updateRow(
        PROJECT_TARGET_TABLE,
        { pilot_enabled_at: at, pilot_enabled_by: actorId, pilot_readiness_version: readinessVersion, updated_at: at },
        { ...key, status: 'active', pilot_enabled_at: null },
      ))
      if (!updated) {
        throw new StockPreparationProjectTargetStoreError(409, PROJECT_TARGET_PILOT_STATE_MOVED_CODE, 'the project row moved while the pilot was being enabled; read it again', { field: 'projectNo' })
      }
      const pilot = rowToPilotState(updated)
      if (onMarked) await onMarked(trx, { pilot })
      return { enabled: true, alreadyEnabled: false, pilot }
    })
  }

  /**
   * PR B readiness: is a plugin table READABLE on this database? `{ readable: true }` after one bounded
   * SELECT; `{ readable: false, reason: 'undefined_table' }` for SQLSTATE 42P01 (a later migration has not
   * run); `{ readable: false, reason: 'read_failed', sqlState? }` for anything else. Never throws, never
   * answers readable for a failure. The table name goes through the db helper's own `integration_` scope.
   */
  async function probeTableReadable(table) {
    try {
      await db.select(table, { limit: 1 })
      return { readable: true }
    } catch (error) {
      const sqlState = error && typeof error.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : undefined
      if (sqlState === UNDEFINED_TABLE_SQLSTATE) return { readable: false, reason: 'undefined_table' }
      return { readable: false, reason: 'read_failed', ...(sqlState ? { sqlState } : {}) }
    }
  }

  return {
    get, list, count, create, archive, restore, withActiveRowLocked, updateProjectFields, getProjectFields, listProjectFields, recordPullOutcome, recordCounts, tryWithOverviewLock,
    getPilotState, getPilotStateBySheetId, markPilotEnabled, probeTableReadable,
  }
}

module.exports = {
  PROJECT_TARGET_TABLE,
  PROJECT_TARGET_STATUSES,
  PROJECT_TARGET_CREATE_LOCK_PREFIX,
  PROJECT_TARGET_ABSENT_CODE,
  PROJECT_TARGET_ARCHIVED_CODE,
  PROJECT_TARGET_ALREADY_ARCHIVED_CODE,
  PROJECT_TARGET_NOT_ARCHIVED_CODE,
  PROJECT_TARGET_IDENTITY_CONFLICT_CODE,
  PROJECT_TARGET_IDENTITY_UNAVAILABLE_CODE,
  PROJECT_TARGET_BUSY_CODE,
  PROJECT_TARGET_LOCK_UNAVAILABLE_CODE,
  PROJECT_TARGET_PREPARE_INVALID_CODE,
  SCOPE_CONSTRAINT,
  SHEET_CONSTRAINT,
  // S3 (R-37): the project-level column whitelist, its caps and codes; the pull-outcome enum.
  PROJECT_FIELD_KEYS,
  PROJECT_FIELD_TEXT_LIMITS,
  PROJECT_FIELDS_INVALID_CODE,
  PROJECT_TARGET_PULL_OUTCOMES,
  PROJECT_TARGET_PULL_CODE_UNKNOWN,
  PROJECT_OVERVIEW_LOCK_PREFIX,
  // PR B (migration 101): the pilot projection, apart from the public target.
  PROJECT_TARGET_PILOT_STATE_MOVED_CODE,
  rowToPilotState,
  StockPreparationProjectTargetStoreError,
  createStockPreparationProjectTargetStore,
  // The activation half of the registration/activation serialization (read-plan store `activate`).
  lockRegistryAndCountCaseFoldedProjectGroups,
  normalizeProjectFieldsPatch,
  normalizeProjectPullCode,
  __internals: {
    rowToPublicTarget,
    rowToProjectFields,
    rowToPilotState,
    dayOrNull,
    isUniqueViolation,
  },
}
