'use strict'

function createAttendanceCalc14SourceReader({HttpError,port,pluginQueryAdapter,mapShiftRow,mapHolidayRow,resolveAttributionTailMinutes,buildAttendanceGroupFixedScheduleProducerKey,deriveFixedScheduleEffectiveness}) {
  async function readAttendanceCalc14SourcesForUser(db, {orgId,userId,workDate}) {
    if (typeof port()?.readAttendanceCalc14GroupSourcesV1 !== 'function') {
      throw new HttpError(503,'ATTENDANCE_CALC14_SOURCE_HISTORY_UNAVAILABLE','ATTENDANCE_CALC14_SOURCE_HISTORY_UNAVAILABLE')
    }
    // Same existing org -> timeline -> schedule lock prefix as W7. Never take the
    // org lock after a per-user schedule lock.
    await port().acquireTimezoneRuntimeLocks(db,{orgId,userId,mode:'shared'})
    const publication=await port().readAttendanceCalc14UserPublicationV1({ query: pluginQueryAdapter(db) },{orgId,userId,workDate})
    if (!publication) throw new HttpError(422,'ATTENDANCE_CALC14_SOURCE_HISTORY_INCOMPLETE','ATTENDANCE_CALC14_SOURCE_HISTORY_INCOMPLETE')
    const memberships=publication.memberships.filter(row=>row.effective_from<=workDate
      && (row.effective_to===null || row.effective_to>=workDate))
    if (memberships.length > 1) throw new HttpError(409,'ATTENDANCE_CALCULATION_GROUP_MEMBERSHIP_OVERLAP','ATTENDANCE_CALCULATION_GROUP_MEMBERSHIP_OVERLAP')
    if (memberships.length !== 1) throw new HttpError(422,'ATTENDANCE_CALC14_SOURCE_HISTORY_INCOMPLETE','ATTENDANCE_CALC14_SOURCE_HISTORY_INCOMPLETE')
    const sources = await port().readAttendanceCalc14GroupSourcesV1({ query: pluginQueryAdapter(db) },{
      orgId,groupId:String(memberships[0].group_id),workDate,
    })
    if (!sources) throw new HttpError(422,'ATTENDANCE_CALC14_SOURCE_HISTORY_INCOMPLETE','ATTENDANCE_CALC14_SOURCE_HISTORY_INCOMPLETE')
    return {...sources,userPublication:publication}
  }

  async function loadAttendanceCalc14PublishedCandidates(db, {orgId,userId,workDates,explicitShiftId}) {
    const candidates = []
    for (const workDate of workDates) {
      const sources = await readAttendanceCalc14SourcesForUser(db,{orgId,userId,workDate})
      const desired = sources.desired
      const producerKey = buildAttendanceGroupFixedScheduleProducerKey({groupId:sources.group.id,
        shiftId:desired.shift_id,startDate:desired.start_date,endDate:desired.end_date})
      const effective = deriveFixedScheduleEffectiveness({
        desired:{shiftId:desired.shift_id,startDate:desired.start_date,endDate:desired.end_date,revision:Number(desired.revision)},
        producerKey,targetMemberIds:sources.members.map(row=>row.user_id),managedRows:sources.publication,evaluatedAt:new Date().toISOString(),
      })
      if (effective.state !== 'effective' || !sources.members.some(row=>row.user_id===userId)) {
        throw new HttpError(422,'ATTENDANCE_CALC14_SOURCE_HISTORY_INCOMPLETE','ATTENDANCE_CALC14_SOURCE_HISTORY_INCOMPLETE')
      }
      // Dates outside the desired coverage are absent candidates, never a current
      // assignment fallback. Selection of a neighboring covered date still works.
      if (workDate < desired.start_date || (desired.end_date && workDate > desired.end_date)) continue
      if (explicitShiftId && desired.shift_id !== explicitShiftId) continue
      const assignments = sources.publication.filter(row=>row.user_id===userId && row.shift_id===desired.shift_id
        && row.producer_key===producerKey && row.publish_status==='published'
        && row.start_date <= workDate && (!row.end_date || row.end_date >= workDate))
      if (assignments.length !== 1) throw new HttpError(409,'ATTENDANCE_CALC14_SOURCE_HISTORY_AMBIGUOUS','ATTENDANCE_CALC14_SOURCE_HISTORY_AMBIGUOUS')
      const publishedAt=row=>(row.publish_status===null || row.publish_status==='published')
        && row.start_date<=workDate && (!row.end_date || row.end_date>=workDate)
      const allPublished=[...sources.userPublication.assignments.filter(publishedAt),...sources.userPublication.rotations.filter(publishedAt)]
      if (allPublished.length !== 1 || allPublished[0].id !== assignments[0].id) {
        throw new HttpError(409,'ATTENDANCE_CALC14_SOURCE_HISTORY_AMBIGUOUS','ATTENDANCE_CALC14_SOURCE_HISTORY_AMBIGUOUS')
      }
      const row = assignments[0]
      const rule = {...mapShiftRow(sources.shift),timezone:sources.shift.timezone ?? sources.group.timezone ?? sources.rule.timezone,
        segmentCount:sources.segments.length || 1,calculationMode:sources.segments.length>1 ? 'segments' : 'legacy',segments:sources.segments.map(segment=>({
        segmentIndex:Number(segment.segment_index),startTime:segment.start_time,endTime:segment.end_time,
        startDayOffset:Number(segment.start_day_offset),endDayOffset:Number(segment.end_day_offset),
      }))}
      const holiday=sources.rule.calc14_holidays.find(row=>row.holiday_date===workDate)
      candidates.push({orgId,userId,workDate,shiftId:desired.shift_id,segmentIndex:null,
        assignmentId:String(row.id),source:'shift',timezone:sources.shift.timezone ?? sources.group.timezone ?? sources.rule.timezone,
        workStartTime:sources.shift.work_start_time,workEndTime:sources.shift.work_end_time,
        isOvernight:sources.shift.is_overnight,rule,calc14Sources:sources,
        attributionTailMinutes:resolveAttributionTailMinutes(sources.rule.calc14_settings),
        calc14Holiday:holiday ? mapHolidayRow(holiday) : null})
    }
    return candidates
  }

  async function readIfGroup(db,input) {
    const arm = await port()?.resolveAttendanceW7GroupArmSelectionV1?.({ query: pluginQueryAdapter(db) },input.orgId)
    return arm?.selectsGroupArm === true ? readAttendanceCalc14SourcesForUser(db,input) : null
  }
  return {readForUser:readAttendanceCalc14SourcesForUser,loadPublishedCandidates:loadAttendanceCalc14PublishedCandidates,readIfGroup}
}

module.exports = {createAttendanceCalc14SourceReader}
