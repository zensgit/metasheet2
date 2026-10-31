import type { AttendanceW4TransactionClientV1 } from './w4c0-identity'
import type { AttendanceW7GroupEffectiveResolverDepsV1, AttendanceW7GroupEffectiveResolverInputV1 } from './w7-resolver/w7-group-effective-facts-resolver'
import type { AttendanceW7LoadedSourceRowsV1 } from './w7-resolver/w7-group-effective-facts-from-rows'
import {
  readAttendanceCalc14GroupSourcesV1,
  readAttendanceCalc14UserPublicationV1,
  attendanceCalc14MembershipsAtV1,
  attendanceCalc14PublishedSourcesAtV1,
} from './attendance-calc14-source-history'

/** Only typed raw rows cross into the shared facts assembler. All version
 * selection is org/date scoped and happens under the resolver's existing locks. */
export async function loadAttendanceCalc14W7SourceRowsInTransactionV1(
  trx: AttendanceW4TransactionClientV1,
  _deps: AttendanceW7GroupEffectiveResolverDepsV1,
  input: AttendanceW7GroupEffectiveResolverInputV1,
): Promise<AttendanceW7LoadedSourceRowsV1 | null> {
  const publication=await readAttendanceCalc14UserPublicationV1(trx,input)
  if (!publication) return null
  const membershipRows=attendanceCalc14MembershipsAtV1(publication,input.workDate)
  const loaded:AttendanceW7LoadedSourceRowsV1={orgId:input.orgId,userId:input.userId,workDate:input.workDate,
    membershipRows,groupRow:null,configRow:null,memberRows:[],managedRows:[],shiftRow:null,segmentRows:[]}
  // The common seam owns absence/overlap outcomes; never choose one member here.
  if (membershipRows.length!==1) return loaded
  const groupId=String(membershipRows[0].group_id ?? '')
  if (!groupId) return null
  const source=await readAttendanceCalc14GroupSourcesV1(trx,{orgId:input.orgId,groupId,workDate:input.workDate})
  if (!source) return null
  const holidays=(source.rule.calc14_holidays as Record<string,unknown>[]).filter(row=>row.holiday_date===input.workDate)
  if (holidays.length>1 || holidays.some(row=>typeof row.is_working_day!=='boolean')) return null
  const isWorkday=holidays.length===1 ? holidays[0].is_working_day===true
    : (source.shift.working_days as number[]).includes(new Date(`${input.workDate}T00:00:00Z`).getUTCDay())
  return {...loaded,groupRow:source.group,configRow:source.desired,memberRows:source.members,
    managedRows:source.publication,shiftRow:source.shift,segmentRows:source.segments,
    publishedSourceRows:attendanceCalc14PublishedSourcesAtV1(publication,input.workDate),
    orgRuleFacts:{severeLateThresholdMinutes:Number(source.rule.severe_late_threshold_minutes),
      absenceLateThresholdMinutes:Number(source.rule.absence_late_threshold_minutes)},
    defaultTimezone:String(source.rule.timezone),calendarFacts:{isWorkday,holidayKind:holidays[0]?.is_working_day===false ? 'holiday' : null}}
}
