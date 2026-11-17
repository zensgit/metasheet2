'use strict'

// ---------------------------------------------------------------------------------------------------
// D2 (switch-on precondition for the YiDa issue-confirm write-back, register R-96) — THE MACHINE COLUMNS OF A
// STOCK-PREP TARGET, as the three generic configured writers see them (the pipelines target adapter and the C6
// write-source in lib/adapters/metasheet-multitable-target-adapter.cjs, the ERP feedback writer in lib/erp-feedback.cjs).
//
// A machine write-back column (MACHINE_WRITEBACK_FIELD_IDS, today `issueConfirmDate`) of a REGISTERED stock-prep
// project sheet has exactly one writer: the write-back. A generic writer may not name it — not by its logical id, not
// by its raw physical id, and not through a `fieldIdMap` alias. So the set a generic writer strips is read from THE
// SHEET, never from the writer's own config (round 2, refuter finding 1: a config without a projectId, or one that
// names the column by another logical name, used to slip past a config-derived set).
//
// THE SHEET'S BINDING (line numbers at ba385e10a; these files are unchanged at 6d2681703). A registry row is inserted
// only by the store's `create` (stock-preparation-project-target-store.cjs:426-431, the only writer of `sheet_id` /
// `object_id`), and its only production caller is the project-sheet route (lib/http-routes.cjs:12259). That route
// provisions under the tenant's staging project `${tenantId}:integration-core` (:12129 `targetProjectId`, :1854-1857)
// and the derived project objectId (provisionProjectSheet -> ensureStockPreparationCanonicalTarget -> ensureObject with
// the template's objectId as the descriptor id, stock-preparation-target-provisioning.cjs:873-877), then registers that
// same result (:12249-12262). The registry never names any other sheet (the store's header, "NO `origin` COLUMN
// (Q3)"). The host derives the sheet id AND every field id of that sheet from the one pair
// (packages/core-backend/src/multitable/provisioning.ts:215-225 getObjectSheetId / getObjectFieldId; findObjectSheet
// :417-423; ensureObject :1107-1133; the additive repair ensureMissingObjectFields :925-934). The two readers of a
// registered sheet bind through that pair too: table-actions' project overlay (stock-preparation-project-targets.cjs
// :171-188 buildProjectTargetBinding, applied by stock-preparation-table-actions.cjs
// createStockPreparationTableActionRegistry) and the write-back's sheet port (branch
// feat/yida-issue-confirm-writeback-wiring-20261106, yida-issue-confirm-writeback-ports.mjs createIssueConfirmSheets:
// createTargetScopedRecordsApi -> resolveTargetFieldIds with `${tenantId}:integration-core`). An explicit operator
// `target.fieldIdMap` (assertTargetFieldMapCompleteness) belongs to the env deployment target, which is never
// registered. The sheet check below does not rely on any of this: it accepts a pair only when it derives THIS sheet.
//
// So the machine columns' physical ids are `resolveFieldIds({ projectId: <pair>, objectId: <registry objectId> })`,
// and the pair is ACCEPTED ONLY WHEN IT PROVABLY NAMES THIS SHEET: `getObjectSheetId(pair) === sheetId`. The registry
// row's tenant is tried first; the writer's tenant and the config's projectId follow (a registry row of another tenant
// on a sheet this tenant provisioned, S6-07). A pair that names another sheet is never used.
//
// FAIL CLOSED. A registered sheet whose machine columns cannot be resolved is REFUSED (closed code below) before any
// records IO — never written unstripped: a probe without the binding read, a registry row gone between the verdict and
// the binding read, a host without the derivations, no candidate pair naming the sheet, or a machine id the host did
// not resolve. The probe's own failures (503 unreadable, 501 not wired) propagate as they are.
//
// Values-free: errors carry the closed code, a closed reason token and the configured object key — never a sheet id, a
// tenant, a project or a field id. No IO of its own: the probe and the provisioning surface are injected.
// ---------------------------------------------------------------------------------------------------

const { MACHINE_WRITEBACK_FIELD_IDS } = require('./stock-preparation-templates.cjs')

const MACHINE_COLUMN_WRITE_CODES = Object.freeze({
  // A registered sheet whose machine columns could not be resolved from its binding: nothing was written.
  UNRESOLVED: 'METASHEET_MULTITABLE_MACHINE_COLUMNS_UNRESOLVED',
  // A configured lookup key IS a machine column of a stock-prep target: stripping it would write keyless rows.
  KEY_REFUSED: 'METASHEET_MULTITABLE_MACHINE_COLUMN_KEY_REFUSED',
  // The fenced update found the row moved between its read and its write (retryable).
  VERSION_CONFLICT: 'METASHEET_MULTITABLE_VERSION_CONFLICT',
  // The row read carried no usable version, so no fenced update can be sent (NOT retryable: a retry reads the same).
  VERSION_UNREADABLE: 'METASHEET_MULTITABLE_VERSION_UNREADABLE',
})

// The host's plugin-SDK conflict (core-backend multitable/record-errors.ts MultitableRecordVersionConflictError.code).
const HOST_RECORD_VERSION_CONFLICT_CODE = 'VERSION_CONFLICT'
// The staging project suffix of the tenant's integration-core project (http-routes.cjs resolveIntegrationStagingProjectId).
const INTEGRATION_STAGING_PROJECT_SUFFIX = ':integration-core'

const UNRESOLVED_REASONS = Object.freeze({
  registry_binding_read_absent: 501,
  provisioning_absent: 501,
  registry_row_absent: 409,
  sheet_binding_mismatch: 409,
  machine_field_unresolved: 409,
})

function nonBlankString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

class GenericWriterMachineColumnError extends Error {
  constructor(status, code, reason, objectId, message) {
    super(message)
    this.name = 'GenericWriterMachineColumnError'
    this.status = status
    this.code = code
    this.retryable = false
    this.details = { reason, ...(nonBlankString(objectId) ? { object: objectId } : {}), partial: false }
  }
}

function machineColumnsUnresolved(reason, objectId) {
  const status = UNRESOLVED_REASONS[reason] || 409
  const object = nonBlankString(objectId) ? `object "${objectId}"` : 'this object'
  return new GenericWriterMachineColumnError(
    status,
    MACHINE_COLUMN_WRITE_CODES.UNRESOLVED,
    reason,
    objectId,
    `${MACHINE_COLUMN_WRITE_CODES.UNRESOLVED} (reason ${reason}): ${object} targets a registered stock-preparation sheet whose machine write-back columns could not be resolved from its binding; nothing was written`,
  )
}

function machineColumnKeyRefused(objectId) {
  const object = nonBlankString(objectId) ? `object "${objectId}"` : 'this object'
  return new GenericWriterMachineColumnError(
    409,
    MACHINE_COLUMN_WRITE_CODES.KEY_REFUSED,
    'machine_column_as_key',
    objectId,
    `${MACHINE_COLUMN_WRITE_CODES.KEY_REFUSED}: ${object} uses a machine write-back column of a stock-preparation sheet as its lookup key; a generic writer may not write that column; nothing was written`,
  )
}

class MultitableVersionConflictError extends Error {
  constructor(objectId) {
    super(`${MACHINE_COLUMN_WRITE_CODES.VERSION_CONFLICT}: the target row changed between the read and the write; nothing was written for this row and it can be retried`)
    this.name = 'MultitableVersionConflictError'
    this.code = MACHINE_COLUMN_WRITE_CODES.VERSION_CONFLICT
    this.retryable = true
    this.details = { ...(nonBlankString(objectId) ? { object: objectId } : {}), retryable: true }
  }
}

class MultitableVersionUnreadableError extends Error {
  constructor(objectId) {
    super(`${MACHINE_COLUMN_WRITE_CODES.VERSION_UNREADABLE}: the target row was read without a usable version, so no fenced update can be sent; nothing was written for this row (a retry reads the same row)`)
    this.name = 'MultitableVersionUnreadableError'
    this.code = MACHINE_COLUMN_WRITE_CODES.VERSION_UNREADABLE
    this.retryable = false
    this.details = { ...(nonBlankString(objectId) ? { object: objectId } : {}), retryable: false }
  }
}

function isHostVersionConflict(error) {
  return Boolean(error && error.code === HOST_RECORD_VERSION_CONFLICT_CODE)
}

/** A row's version as the fence needs it: a positive safe integer, else null (unreadable). */
function fenceVersionOf(row) {
  const version = row ? row.version : undefined
  return Number.isSafeInteger(version) && version >= 1 ? version : null
}

/**
 * THE machine columns' physical ids on a REGISTERED sheet, from its registry binding (see the header). Returns a frozen
 * list of physical ids, one per MACHINE_WRITEBACK_FIELD_IDS entry; throws the closed refusal otherwise.
 *   governedSheetProbe.registryBindingBySheet({ sheetId }) -> { tenantId, objectId } | null
 *   provisioning.getObjectSheetId(projectId, objectId) / provisioning.resolveFieldIds({ projectId, objectId, fieldIds })
 * `candidateTenantIds` / `candidateProjectIds`: tried after the registry row's own tenant, in order.
 */
async function resolveRegisteredSheetMachineColumns({ governedSheetProbe, provisioning, sheetId, objectId, candidateTenantIds = [], candidateProjectIds = [] } = {}) {
  if (!governedSheetProbe || typeof governedSheetProbe.registryBindingBySheet !== 'function') {
    throw machineColumnsUnresolved('registry_binding_read_absent', objectId)
  }
  const binding = await governedSheetProbe.registryBindingBySheet({ sheetId })
  if (!isPlainObject(binding) || !nonBlankString(binding.objectId) || !nonBlankString(binding.tenantId)) {
    throw machineColumnsUnresolved('registry_row_absent', objectId)
  }
  if (!provisioning || typeof provisioning.getObjectSheetId !== 'function' || typeof provisioning.resolveFieldIds !== 'function') {
    throw machineColumnsUnresolved('provisioning_absent', objectId)
  }
  const candidates = []
  const add = (projectId) => {
    if (nonBlankString(projectId) && !candidates.includes(projectId)) candidates.push(projectId)
  }
  add(`${binding.tenantId}${INTEGRATION_STAGING_PROJECT_SUFFIX}`)
  for (const tenantId of candidateTenantIds) if (nonBlankString(tenantId)) add(`${tenantId}${INTEGRATION_STAGING_PROJECT_SUFFIX}`)
  for (const projectId of candidateProjectIds) add(projectId)
  let pair = null
  for (const projectId of candidates) {
    let derived
    try {
      derived = await provisioning.getObjectSheetId(projectId, binding.objectId)
    } catch {
      // A project the host refuses to derive for is simply not this sheet's pair.
      continue
    }
    if (derived === sheetId) {
      pair = projectId
      break
    }
  }
  if (!pair) throw machineColumnsUnresolved('sheet_binding_mismatch', objectId)
  const resolved = await provisioning.resolveFieldIds({ projectId: pair, objectId: binding.objectId, fieldIds: [...MACHINE_WRITEBACK_FIELD_IDS] })
  const physicalIds = MACHINE_WRITEBACK_FIELD_IDS.map((fieldId) => (isPlainObject(resolved) && nonBlankString(resolved[fieldId]) ? resolved[fieldId] : null))
  if (physicalIds.some((physical) => physical === null)) throw machineColumnsUnresolved('machine_field_unresolved', objectId)
  return Object.freeze(physicalIds)
}

/**
 * The payload keys that name a machine column: the logical ids, every physical id given, the physical id a
 * `logicalToPhysical` map gives a logical machine id, and every ALIAS — a logical name the map sends to one of them.
 */
function machineColumnKeySet({ physicalIds = [], logicalToPhysical = {} } = {}) {
  const keys = new Set(MACHINE_WRITEBACK_FIELD_IDS)
  for (const physical of physicalIds) if (nonBlankString(physical)) keys.add(physical)
  const map = isPlainObject(logicalToPhysical) ? logicalToPhysical : {}
  for (const fieldId of MACHINE_WRITEBACK_FIELD_IDS) if (nonBlankString(map[fieldId])) keys.add(map[fieldId])
  for (const [logical, physical] of Object.entries(map)) {
    if (nonBlankString(physical) && keys.has(physical)) keys.add(logical)
  }
  return keys
}

function omitMachineColumns(data, keys) {
  const out = {}
  let stripped = 0
  for (const [field, value] of Object.entries(isPlainObject(data) ? data : {})) {
    if (keys.has(field)) stripped += 1
    else out[field] = value
  }
  return { data: out, stripped }
}

/** Refuse a lookup key that is a machine column (by its logical name or its mapped physical id). */
function assertNoMachineKeyField(keys, keyFields, logicalToPhysical, objectId) {
  const map = isPlainObject(logicalToPhysical) ? logicalToPhysical : {}
  for (const field of Array.isArray(keyFields) ? keyFields : []) {
    if (keys.has(field) || (nonBlankString(map[field]) && keys.has(map[field]))) throw machineColumnKeyRefused(objectId)
  }
}

module.exports = {
  MACHINE_COLUMN_WRITE_CODES,
  HOST_RECORD_VERSION_CONFLICT_CODE,
  INTEGRATION_STAGING_PROJECT_SUFFIX,
  GenericWriterMachineColumnError,
  MultitableVersionConflictError,
  MultitableVersionUnreadableError,
  isHostVersionConflict,
  fenceVersionOf,
  resolveRegisteredSheetMachineColumns,
  machineColumnKeySet,
  omitMachineColumns,
  assertNoMachineKeyField,
  machineColumnsUnresolved,
}
