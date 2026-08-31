const { isDeepStrictEqual } = require('node:util')

const INVALID_PLAN = 'ATTENDANCE_REPORT_MANAGED_CONTENT_INVALID'

function isPlainRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function buildAttendanceReportManagedContentPlan(input) {
  if (!isPlainRecord(input) || !isPlainRecord(input.existingData) || !isPlainRecord(input.desiredData)) {
    throw new Error(INVALID_PLAN)
  }
  if (!Array.isArray(input.managedFieldIds) || typeof input.volatileFieldId !== 'string') {
    throw new Error(INVALID_PLAN)
  }

  const managedFieldIds = [...new Set(input.managedFieldIds)]
  if (
    managedFieldIds.length === 0
    || managedFieldIds.some(fieldId => typeof fieldId !== 'string' || fieldId.length === 0)
  ) {
    throw new Error(INVALID_PLAN)
  }
  for (const fieldId of managedFieldIds) {
    if (!Object.prototype.hasOwnProperty.call(input.desiredData, fieldId)) {
      throw new Error(INVALID_PLAN)
    }
  }

  const contentMatches = managedFieldIds
    .filter(fieldId => fieldId !== input.volatileFieldId)
    .every(fieldId => isDeepStrictEqual(input.existingData[fieldId], input.desiredData[fieldId]))

  if (input.fingerprintsMatch === true && contentMatches) {
    return { action: 'skip', reason: 'clean', changes: null }
  }

  const changes = Object.fromEntries(
    managedFieldIds.map(fieldId => [fieldId, input.desiredData[fieldId]]),
  )
  return {
    action: 'patch',
    reason: input.fingerprintsMatch === true ? 'managed_drift' : 'fingerprint_mismatch',
    changes,
  }
}

module.exports = {
  buildAttendanceReportManagedContentPlan,
}
