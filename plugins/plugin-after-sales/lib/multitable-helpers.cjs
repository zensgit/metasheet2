'use strict'

async function findObjectSheetId(provisioning, projectId, objectId) {
  if (provisioning && typeof provisioning.findObjectSheet === 'function') {
    const sheet = await provisioning.findObjectSheet({ projectId, objectId })
    if (sheet && typeof sheet.id === 'string' && sheet.id) {
      return sheet.id
    }
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
  findObjectSheetId,
  resolvePhysicalFieldIds,
  toPhysicalRecord,
  fromPhysicalRecord,
}
