// Read-only display hint; the canonical query-only posture port owns admission.
// Lock: attendance-w6-reference-capability-fidelity-design-lock-20261025.md.
// This hint is never passed to a writer guard or used as calculator availability.
async function readAttendanceShiftReferenceCapability(db, port, orgId) {
  if (!port || typeof port.resolveTimezoneSegmentReferencePosture !== 'function') return false
  if (!db || typeof db.transaction !== 'function') return false
  try {
    return await db.transaction(async (trx) => {
      await trx.query('SET TRANSACTION READ ONLY')
      const posture = await port.resolveTimezoneSegmentReferencePosture(trx, orgId)
      return posture?.referenceSegments === true
    })
  } catch {
    // An unavailable non-authoritative hint remains closed. The existing writer
    // independently resolves its own authorization on its own transaction.
    return false
  }
}

module.exports = { readAttendanceShiftReferenceCapability }
