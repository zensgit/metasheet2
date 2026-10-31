const instant = (value) => {
  if (!(value instanceof Date) && typeof value !== 'string') return null
  const parsed = value instanceof Date ? value : new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null
}
const nonNegativeInteger = (value) => Number.isInteger(value) && value >= 0 ? value : null

/** Resolve one published target on the preparation host's locked client; retain the full event vector. */
function createAttendancePunchDetailFrozenTargetResolverV1(deps) {
  const { HttpError, port, loadDefaultRule, createWorkDateResolver, loadShiftById,
    resolveWorkContext, issueFrozenContext, parseOvertimeAttribution } = deps
  const refuse = (code) => { throw new HttpError(422, code, code) }
  return async function resolveFrozenTarget(trx, { orgId, input, referenceSegments }) {
    if (referenceSegments !== true) refuse('ATTENDANCE_PUNCH_DETAIL_CANONICAL_POSTURE_REQUIRED')
    const baseRule = await loadDefaultRule(trx, orgId)
    // Preserve import's first available check-in (otherwise checkout) anchor.
    // It selects the target only; every accepted event remains calculation evidence.
    const anchor = input.punches.find((punch) => punch.direction === 'check_in') ?? input.punches[0]
    const { adapters } = createWorkDateResolver(trx, { lockScheduleFacts: true, strictSources: true, strictWallInstants: true })
    const resolved = await adapters.import.resolveImportWorkDate({
      orgId, userId: input.userId, occurredAt: new Date(anchor.occurredAt),
      timezone: baseRule.timezone, calendarWorkDate: input.workDate,
      explicitWorkDate: input.workDate, explicitShiftId: null, includeFullWinner: true,
    })
    if (resolved.kind === 'ambiguous') refuse('WORK_DATE_ATTRIBUTION_AMBIGUOUS')
    if (resolved.kind !== 'resolved' || !resolved.fullWinner) refuse('WORK_DATE_ATTRIBUTION_UNRESOLVED')
    const winner = resolved.fullWinner
    if (resolved.workDate !== input.workDate || winner.workDate !== input.workDate
      || winner.orgId !== orgId || winner.userId !== input.userId
      || winner.shiftId !== resolved.shiftId || winner.timezone !== input.timezone) {
      refuse('ATTENDANCE_PUNCH_DETAIL_FROZEN_TARGET_MISMATCH')
    }
    const shift = await loadShiftById(trx, orgId, resolved.shiftId, true)
    if (!shift || shift.id !== resolved.shiftId || shift.orgId !== orgId) {
      refuse('ATTENDANCE_PUNCH_DETAIL_FROZEN_TARGET_MISMATCH')
    }
    const workContext = await resolveWorkContext({
      db: trx, orgId, userId: input.userId, workDate: resolved.workDate,
      defaultRule: baseRule, referenceSegments: true, strictSources: true,
      publishedProfile: { rule: shift, source: winner.source,
        assignmentId: winner.assignmentId, rotationRuleId: winner.rotationRuleId },
    })
    const approvedOvertimeWindows = (resolved.approvedOvertimeWindows ?? []).flatMap((entry) => {
      const parsed = parseOvertimeAttribution(entry?.anchor)
      const approvedEndAt = instant(entry?.approvedEndAt)
      if (!parsed || !approvedEndAt
        || entry.orgId !== orgId || entry.userId !== input.userId
        || entry.workDate !== resolved.workDate || entry.shiftId !== resolved.shiftId
        || parsed.orgId !== orgId || parsed.userId !== input.userId
        || parsed.workDate !== resolved.workDate || parsed.shiftId !== resolved.shiftId) return []
      return [{ requestId: String(entry.requestId), approvedEndAt, anchor: parsed }]
    })
    const absolute = { startAt: instant(winner.absoluteWindow?.startAt), endAt: instant(winner.absoluteWindow?.endAt) }
    const attributionWindow = { startAt: instant(winner.attributionWindow?.startAt), endAt: instant(winner.attributionWindow?.endAt) }
    if (!absolute.startAt || !absolute.endAt || !attributionWindow.startAt || !attributionWindow.endAt) {
      refuse('ATTENDANCE_IMPORT_ATTRIBUTION_PROOF_INVALID')
    }
    const attribution = port.buildImportAttributionFreeze({
      orgId, userId: input.userId, workDate: resolved.workDate, shiftId: resolved.shiftId,
      reasonCode: resolved.reasonCode, resolvedAt: new Date().toISOString(),
      timezone: winner.timezone, workStartTime: winner.workStartTime, workEndTime: winner.workEndTime,
      isOvernight: winner.isOvernight, candidateAbsoluteWindow: absolute,
      candidateAttributionWindow: attributionWindow, attributionTailMinutes: resolved.attributionTailMinutes,
      approvedOvertimeWindows,
    })
    if (attribution.kind !== 'resolved_v2') refuse('ATTENDANCE_IMPORT_ATTRIBUTION_PROOF_INVALID')
    const issued = await issueFrozenContext(trx, {
      orgId, userId: input.userId, workDate: resolved.workDate, shiftId: resolved.shiftId,
      timezone: winner.timezone, defaultRule: baseRule, isWorkday: workContext.isWorkingDay,
      holidayKind: workContext.holiday
        ? (workContext.holiday.type ?? (workContext.holiday.isWorkingDay === false ? 'holiday' : 'working_day_override'))
        : null,
    })
    if (!issued?.context) refuse('ATTENDANCE_PUNCH_DETAIL_FROZEN_TARGET_MISMATCH')
    const rule = workContext.rule
    const policySourceProof = port.buildImportPolicySourceProof({
      ruleVersion: 'org-default-rule', engineVersion: null,
      rule: {
        timezone: rule.timezone, workStartTime: rule.workStartTime, workEndTime: rule.workEndTime,
        lateGraceMinutes: nonNegativeInteger(rule.lateGraceMinutes),
        earlyGraceMinutes: nonNegativeInteger(rule.earlyGraceMinutes ?? rule.earlyLeaveGraceMinutes),
        roundingMinutes: nonNegativeInteger(rule.roundingMinutes),
        severeLateThresholdMinutes: nonNegativeInteger(rule.severeLateThresholdMinutes),
        absenceLateThresholdMinutes: nonNegativeInteger(rule.absenceLateThresholdMinutes),
        workingDays: rule.workingDays,
      },
      // Physical-event input uses the canonical frozen context, not daily metric overrides.
      policy: { appliedRules: [], userGroups: [] }, engine: null,
    })
    return { attribution, context: issued.context, policySourceProof }
  }
}

module.exports = { createAttendancePunchDetailFrozenTargetResolverV1 }
