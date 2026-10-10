'use strict'

/**
 * #5835 — an ABSENT or SOFT-DELETED object sheet is an answer, never a fallback.
 *
 * `provisioning.findObjectSheet` reads meta_sheets with `deleted_at IS NULL`, so its null is
 * authoritative: the object sheet this project derives is either gone (soft-deleted) or was never
 * provisioned. The old code answered that null by returning `provisioning.getObjectSheetId(...)` —
 * the same id, derived by rule, with the liveness question dropped — and every caller then read and
 * wrote records with it. Since #5834 the core record ops refuse a deleted sheet, so nothing leaked;
 * what the operator saw was a bare 404 per request, with no way to tell "the table was deleted" from
 * "that record does not exist". This throws a coded, values-free error instead, which the plugin's
 * route layer turns into a guided Chinese hint (index.cjs `sendObjectSheetUnavailable`).
 *
 * VALUES-FREE: the error names the LOGICAL object id ('serviceTicket', 'followUp', ...) and a reason.
 * It never carries the project id, the derived sheet id, a tenant or any record value.
 */
const OBJECT_SHEET_UNAVAILABLE_CODE = 'OBJECT_SHEET_UNAVAILABLE'

/**
 * Why the object sheet is not usable.
 *  - 'deleted': the registry still claims the derived sheet id for this project, but the sheet is not
 *    live -> it was soft-deleted. ONLY a restore brings the app back. RE-INSTALLING DOES NOT: the
 *    soft-deleted row still owns the deterministic id, so `ensureSheet`
 *    (core-backend src/multitable/provisioning.ts `INSERT ... ON CONFLICT (id) DO NOTHING` then
 *    `loadActiveSheet` with `deleted_at IS NULL`) inserts nothing, reads back null and throws
 *    `Failed to ensure sheet: <id>`; the after-sales installer turns any such throw into a
 *    status='failed' ledger row (lib/installer.cjs), after which every route answers
 *    AFTER_SALES_NOT_INSTALLED. The hint for this reason must therefore never advise 重新开通.
 *  - 'absent' : no registry claim -> the object was never provisioned for this project.
 *  - 'unknown': the host exposes no registry predicate (or it failed), so the two cannot be told
 *    apart. Still a refusal: the reason only chooses the wording of the hint, never whether to refuse.
 */
const OBJECT_SHEET_UNAVAILABLE_REASONS = Object.freeze({
  ABSENT: 'absent',
  DELETED: 'deleted',
  UNKNOWN: 'unknown',
})

function buildObjectSheetUnavailableError(objectId, reason) {
  const error = new Error(
    `After-sales object sheet is unavailable (object=${objectId}, reason=${reason})`,
  )
  error.code = OBJECT_SHEET_UNAVAILABLE_CODE
  error.reason = reason
  error.meta = { objectId, reason }
  return error
}

function isObjectSheetUnavailableError(err) {
  return Boolean(err) && err.code === OBJECT_SHEET_UNAVAILABLE_CODE
}

/**
 * Absent or deleted? Asked of `plugin_multitable_object_registry` through the host's boolean
 * predicate: that row is written by `ensureObject` and is NOT removed when a sheet is soft-deleted,
 * so "claimed but not live" is exactly "deleted".
 *
 * The derived id computed here serves that YES/NO question ONLY — it is never returned and never
 * reaches a record call. Any failure degrades the WORDING to 'unknown'; it can never turn the refusal
 * into a pass.
 *
 * SCOPE OF 'absent' — it is "no claim", which is "never provisioned" only for registry-era installs.
 * The registry was backfilled by
 * `packages/core-backend/src/db/migrations/zzzz20260408160000_backfill_after_sales_plugin_multitable_object_registry.ts`,
 * whose SELECT joins `meta_sheets ... AND deleted_at IS NULL`: an object whose sheet was ALREADY
 * soft-deleted when that migration ran got NO row, so it classifies as 'absent' even though it was
 * provisioned once and then deleted. That is why the 'absent' hint (index.cjs
 * OBJECT_SHEET_UNAVAILABLE_HINTS) does not promise that 开通 alone will succeed. The mis-wording
 * costs wording only: both reasons refuse, and neither ever returns the derived id.
 */
async function classifyUnavailableObjectSheet(provisioning, projectId, objectId) {
  if (
    !provisioning ||
    typeof provisioning.isSheetOwnedByProject !== 'function' ||
    typeof provisioning.getObjectSheetId !== 'function'
  ) {
    return OBJECT_SHEET_UNAVAILABLE_REASONS.UNKNOWN
  }
  try {
    const claimedSheetId = provisioning.getObjectSheetId(projectId, objectId)
    const claimed = await provisioning.isSheetOwnedByProject(claimedSheetId, projectId)
    return claimed
      ? OBJECT_SHEET_UNAVAILABLE_REASONS.DELETED
      : OBJECT_SHEET_UNAVAILABLE_REASONS.ABSENT
  } catch {
    return OBJECT_SHEET_UNAVAILABLE_REASONS.UNKNOWN
  }
}

/**
 * The LIVE sheet id of a provisioned object, or a refusal.
 *
 * FAIL-CLOSED in both directions: a null from `findObjectSheet` throws OBJECT_SHEET_UNAVAILABLE, and a
 * THROW from it propagates untouched (a transient lookup failure must not be reported to the operator
 * as "your table was deleted", and must not fall through to the derived id either). Neither path
 * issues a record query.
 *
 * The `getObjectSheetId` branch below is NOT a fallback for a missing sheet: it is reached only when
 * the host exposes no `findObjectSheet` at all, i.e. when the deployment has no liveness capability to
 * ask. Shipped hosts implement it (core-backend src/index.ts, multitable/plugin-scope.ts).
 */
async function findObjectSheetId(provisioning, projectId, objectId) {
  if (provisioning && typeof provisioning.findObjectSheet === 'function') {
    const sheet = await provisioning.findObjectSheet({ projectId, objectId })
    if (sheet && typeof sheet.id === 'string' && sheet.id) {
      return sheet.id
    }
    throw buildObjectSheetUnavailableError(
      objectId,
      await classifyUnavailableObjectSheet(provisioning, projectId, objectId),
    )
  }
  if (provisioning && typeof provisioning.getObjectSheetId === 'function') {
    return provisioning.getObjectSheetId(projectId, objectId)
  }
  throw new Error('Multitable provisioning object resolver is not available')
}

async function resolvePhysicalFieldIds(provisioning, projectId, objectId, logicalFieldIds) {
  if (!Array.isArray(logicalFieldIds) || logicalFieldIds.length === 0) {
    return {}
  }

  if (provisioning && typeof provisioning.resolveFieldIds === 'function') {
    const resolved = await provisioning.resolveFieldIds({
      projectId,
      objectId,
      fieldIds: logicalFieldIds,
    })
    if (resolved && typeof resolved === 'object') {
      return resolved
    }
  }

  if (provisioning && typeof provisioning.getFieldId === 'function') {
    const resolved = {}
    for (const logicalFieldId of logicalFieldIds) {
      resolved[logicalFieldId] = provisioning.getFieldId(projectId, objectId, logicalFieldId)
    }
    return resolved
  }

  return {}
}

/**
 * Translates a record keyed by logical field ids (e.g. { ticketNo: 'TK-001' })
 * into the physical meta_fields ids that multitable.records.createRecord and
 * patchRecord expect.
 *
 * Prefers provisioning.resolveFieldIds/findObjectSheet so plugin code does not
 * need to know the physical id derivation strategy. Falls back to the legacy
 * getter-based API when newer helpers are unavailable.
 *
 * @param {object} provisioning - context.api.multitable.provisioning
 * @param {string} projectId
 * @param {string} objectId - logical object id, e.g. 'serviceTicket'
 * @param {Record<string, unknown>} logicalData - record data keyed by logical field id
 * @returns {Promise<Record<string, unknown>>} record data keyed by physical field id
 */
async function toPhysicalRecord(provisioning, projectId, objectId, logicalData) {
  if (!logicalData || typeof logicalData !== 'object') return {}
  const resolved = await resolvePhysicalFieldIds(
    provisioning,
    projectId,
    objectId,
    Object.keys(logicalData),
  )
  if (!Object.keys(resolved).length) {
    return logicalData
  }
  const out = {}
  for (const [key, value] of Object.entries(logicalData)) {
    const physicalId = resolved[key]
    out[physicalId || key] = value
  }
  return out
}

/**
 * Reverse direction: translates a record keyed by physical field ids back to
 * logical ids. Useful for reading records from multitable and returning them
 * with domain-meaningful keys.
 *
 * @param {object} provisioning
 * @param {string} projectId
 * @param {string} objectId
 * @param {string[]} logicalFieldIds - the logical ids to resolve
 * @param {Record<string, unknown>} physicalData
 * @returns {Promise<Record<string, unknown>>}
 */
async function fromPhysicalRecord(provisioning, projectId, objectId, logicalFieldIds, physicalData) {
  if (!physicalData || typeof physicalData !== 'object') return {}
  const resolved = await resolvePhysicalFieldIds(
    provisioning,
    projectId,
    objectId,
    logicalFieldIds,
  )
  if (!Object.keys(resolved).length) {
    return physicalData
  }
  const out = {}
  for (const logicalId of logicalFieldIds) {
    const physicalId = resolved[logicalId]
    if (physicalId in physicalData) {
      out[logicalId] = physicalData[physicalId]
    }
  }
  return out
}

module.exports = {
  OBJECT_SHEET_UNAVAILABLE_CODE,
  OBJECT_SHEET_UNAVAILABLE_REASONS,
  buildObjectSheetUnavailableError,
  classifyUnavailableObjectSheet,
  isObjectSheetUnavailableError,
  findObjectSheetId,
  resolvePhysicalFieldIds,
  toPhysicalRecord,
  fromPhysicalRecord,
}
