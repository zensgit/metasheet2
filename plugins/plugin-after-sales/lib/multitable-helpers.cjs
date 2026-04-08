'use strict'

/**
 * Translates a record keyed by logical field ids (e.g. { ticketNo: 'TK-001' })
 * into the physical meta_fields ids that multitable.records.createRecord and
 * patchRecord expect (e.g. { fld_<sha1>: 'TK-001' }).
 *
 * The translation is done via MultitableProvisioningAPI.getFieldId which mirrors
 * the stable-hash convention used by ensureObject / ensureFields when the
 * template was installed.
 *
 * @param {object} provisioning - context.api.multitable.provisioning
 * @param {string} projectId
 * @param {string} objectId - logical object id, e.g. 'serviceTicket'
 * @param {Record<string, unknown>} logicalData - record data keyed by logical field id
 * @returns {Record<string, unknown>} record data keyed by physical (hashed) field id
 */
function toPhysicalRecord(provisioning, projectId, objectId, logicalData) {
  if (!logicalData || typeof logicalData !== 'object') return {}
  if (!provisioning || typeof provisioning.getFieldId !== 'function') {
    return logicalData
  }
  const out = {}
  for (const [key, value] of Object.entries(logicalData)) {
    out[provisioning.getFieldId(projectId, objectId, key)] = value
  }
  return out
}

/**
 * Reverse direction: translates a record keyed by physical (hashed) field ids
 * back to logical ids. Useful for reading records from multitable and returning
 * them with domain-meaningful keys.
 *
 * @param {object} provisioning
 * @param {string} projectId
 * @param {string} objectId
 * @param {string[]} logicalFieldIds - the logical ids to resolve
 * @param {Record<string, unknown>} physicalData
 * @returns {Record<string, unknown>}
 */
function fromPhysicalRecord(provisioning, projectId, objectId, logicalFieldIds, physicalData) {
  if (!physicalData || typeof physicalData !== 'object') return {}
  if (!provisioning || typeof provisioning.getFieldId !== 'function') {
    return physicalData
  }
  const out = {}
  for (const logicalId of logicalFieldIds) {
    const physicalId = provisioning.getFieldId(projectId, objectId, logicalId)
    if (physicalId in physicalData) {
      out[logicalId] = physicalData[physicalId]
    }
  }
  return out
}

module.exports = {
  toPhysicalRecord,
  fromPhysicalRecord,
}
