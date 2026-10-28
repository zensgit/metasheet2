'use strict'

const MULTI_SEGMENT_DISABLED = 'ATTENDANCE_SHIFT_MULTI_SEGMENT_CALCULATION_DISABLED'

function createAttendanceGroupFixedScheduleEditorService({ HttpError, getEffectiveness, resolveReferenceSegments }) {
  async function getEditor(trx, input) {
    const effectiveness = await getEffectiveness(trx, input)
    const shiftId = input.shiftId ?? effectiveness.desired?.shiftId ?? null
    let referenceEligibility = null
    if (shiftId) {
      let referenceSegments
      try {
        referenceSegments = await resolveReferenceSegments(trx, input.orgId)
      } catch {
        throw new HttpError(503, 'ATTENDANCE_FIXED_SCHEDULE_EDITOR_UNAVAILABLE', 'Fixed schedule reference eligibility unavailable')
      }
      const shifts = await trx.query(
        'SELECT id FROM attendance_shifts WHERE id = $1 AND org_id = $2 FOR SHARE',
        [shiftId, input.orgId],
      )
      if (!shifts.length) throw new HttpError(404, 'NOT_FOUND', 'Shift not found')
      let segmentCount
      try {
        const rows = await trx.query(
          'SELECT COUNT(*)::int AS total FROM attendance_shift_segments WHERE org_id = $1 AND shift_id = $2',
          [input.orgId, shiftId],
        )
        segmentCount = rows[0]?.total
        if (segmentCount == null || !Number.isSafeInteger(Number(segmentCount)) || Number(segmentCount) < 0) {
          throw new Error('ATTENDANCE_SHIFT_SEGMENT_STATE_UNAVAILABLE')
        }
      } catch {
        throw new HttpError(503, 'ATTENDANCE_FIXED_SCHEDULE_EDITOR_UNAVAILABLE', 'Fixed schedule reference eligibility unavailable')
      }
      const allowed = Number(segmentCount) <= 1 || referenceSegments === true
      referenceEligibility = { shiftId, allowed, reasonCode: allowed ? null : MULTI_SEGMENT_DISABLED }
    }
    return {
      groupId: effectiveness.groupId,
      state: effectiveness.state,
      reasonCodes: effectiveness.reasonCodes,
      desired: effectiveness.desired,
      drift: { managedSets: effectiveness.drift.managedSets },
      referenceEligibility,
    }
  }

  return { getEditor }
}

module.exports = { createAttendanceGroupFixedScheduleEditorService }
