import type { AttendanceW4TransactionClientV1 } from './w4c0-identity'
import { parseCanonicalAttendanceWorkDateV1 } from './w4c0-identity'

type SourceKind = 'group' | 'desired' | 'shift' | 'rule' | 'rule_set' | 'members' | 'publication' | 'user_publication'
type SourceRow = Record<string, unknown>

export interface AttendanceCalc14SourceInputsV1 {
  group: SourceRow
  desired: SourceRow
  shift: SourceRow
  segments: SourceRow[]
  members: SourceRow[]
  publication: SourceRow[]
  rule: SourceRow
  ruleSet: SourceRow | null
}

function object(value: unknown): value is SourceRow {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function rows(value: unknown): value is SourceRow[] {
  return Array.isArray(value) && value.every(object)
}

/** Business date is the ONLY winner ordering. No recorded-at/latest-row fallback.
 * Current-source coherence detects edits performed while the gate was OFF.
 * Such an edit cannot leave previously retained inputs silently authoritative. */
export async function readAttendanceCalc14SourceVersionV1(
  trx: AttendanceW4TransactionClientV1,
  input: { orgId: string; kind: SourceKind; sourceId: string; workDate: string },
): Promise<unknown | null> {
  const workDate = parseCanonicalAttendanceWorkDateV1(input.workDate)
  const result = await trx.query(`SELECT v.id, v.payload, v.business_effective_date::text AS business_effective_date
    FROM attendance_calc14_source_versions v
    WHERE v.org_id=$1 AND v.source_kind=$2 AND v.source_id=$3 AND v.event_kind='version'
      AND v.business_effective_date=(SELECT max(s.business_effective_date)
        FROM attendance_calc14_source_versions s WHERE s.org_id=$1 AND s.source_kind=$2
          AND s.source_id=$3 AND s.event_kind='version' AND s.business_effective_date <= $4::date)
      AND NOT EXISTS (SELECT 1 FROM attendance_calc14_source_versions gap
        WHERE gap.org_id=v.org_id AND gap.source_kind=v.source_kind AND gap.source_id=v.source_id
          AND gap.event_kind='unversioned_change' AND gap.id > v.id)
      AND (SELECT latest.payload FROM attendance_calc14_source_versions latest
        WHERE latest.org_id=v.org_id AND latest.source_kind=v.source_kind AND latest.source_id=v.source_id AND latest.event_kind='version'
        ORDER BY latest.business_effective_date DESC LIMIT 1)
        IS NOT DISTINCT FROM attendance_calc14_source_payload(v.org_id,v.source_kind,v.source_id)
    FOR SHARE`, [input.orgId, input.kind, input.sourceId, workDate])
  if (result.rows.length > 1) throw new Error('ATTENDANCE_CALC14_SOURCE_HISTORY_AMBIGUOUS')
  if (result.rows.length !== 1 || result.rows[0].payload === null) return null
  const payload = result.rows[0].payload
  const version=Number(result.rows[0].id)
  if (!Number.isSafeInteger(version) || version<1) return null
  return object(payload) ? {...payload, __calc14_version:version} : payload
}

/** Raw inputs, not a derived policy or frozen context. The existing resolver
 * still owns FSER composition and normalized facts, and the existing issuer is
 * still the sole producer of V2. Caller holds existing org/identity source locks. */
export async function readAttendanceCalc14GroupSourcesV1(
  trx: AttendanceW4TransactionClientV1,
  input: { orgId: string; groupId: string; workDate: string },
): Promise<AttendanceCalc14SourceInputsV1 | null> {
  const read = (kind: SourceKind, sourceId = input.groupId) => readAttendanceCalc14SourceVersionV1(trx, {
    orgId: input.orgId, kind, sourceId, workDate: input.workDate,
  })
  // A single transaction/lock owner reads all inputs; do not issue pooled reads.
  const group = await read('group')
  const desired = await read('desired')
  const members = await read('members')
  const publication = await read('publication')
  const rule = await read('rule', input.orgId)
  if (!object(group) || !object(desired) || !rows(members) || !rows(publication) || !object(rule)) return null
  if (group.id !== input.groupId || group.org_id !== input.orgId || group.attendance_type !== 'fixed_shift'
    || typeof desired.shift_id !== 'string' || !desired.shift_id || rule.org_id !== input.orgId) return null
  let ruleSet:SourceRow|null=null
  if (group.rule_set_id!==null && group.rule_set_id!==undefined) {
    if (typeof group.rule_set_id!=='string' || !group.rule_set_id) return null
    const version=await read('rule_set',group.rule_set_id)
    if (!object(version) || version.id!==group.rule_set_id || version.org_id!==input.orgId || !object(version.config)) return null
    ruleSet=version
  }
  const shift = await read('shift', desired.shift_id)
  if (!object(shift) || shift.id !== desired.shift_id || shift.org_id !== input.orgId
    || shift.flex_mode !== 'strict' || !rows(shift.segments)) return null
  for (const field of ['severe_late_threshold_minutes', 'absence_late_threshold_minutes']) {
    if (!Number.isSafeInteger(rule[field]) || Number(rule[field]) < 0) return null
  }
  if (!rows(rule.calc14_holidays) || !object(rule.calc14_timezone_policy)
    || typeof rule.calc14_timezone_policy.enabled !== 'boolean'
    || !Number.isSafeInteger(rule.calc14_timezone_policy.version)
    || Number(rule.calc14_timezone_policy.version)<(rule.calc14_timezone_policy.enabled ? 1 : 0)) return null
  let settings=rule.calc14_settings
  try { if (typeof settings==='string') settings=JSON.parse(settings) } catch { return null }
  if (settings!==null && settings!==undefined && !object(settings)) return null
  // User/dept selector histories are not part of this strict input slice. An
  // override must not be applied using today's scope membership for an old date.
  if (object(settings) && settings.calendarPolicy!==undefined
    && (!object(settings.calendarPolicy) || (settings.calendarPolicy.overrides!==undefined && !Array.isArray(settings.calendarPolicy.overrides)))) return null
  if (object(settings) && object(settings.calendarPolicy)
    && Array.isArray(settings.calendarPolicy.overrides) && settings.calendarPolicy.overrides.length>0) return null
  if (!Array.isArray(shift.working_days) || shift.working_days.length===0
    || shift.working_days.some(day=>!Number.isInteger(day) || Number(day)<0 || Number(day)>6)) return null
  if (members.some(row => typeof row.user_id !== 'string' || !row.user_id)) return null
  if (new Set(members.map(row => row.user_id)).size !== members.length) return null
  if (publication.some(row => row.org_id !== input.orgId
    || row.producer_type !== 'attendance_group_fixed_schedule' || row.producer_ref_id !== input.groupId)) return null
  const zone = shift.timezone ?? group.timezone ?? rule.timezone
  if (typeof zone !== 'string' || !zone) return null
  try { new Intl.DateTimeFormat('en', { timeZone: zone }).format(new Date(0)) } catch { return null }
  return { group, desired, shift, segments: shift.segments, members, publication, rule, ruleSet }
}

export interface AttendanceCalc14UserPublicationV1 {
  memberships: SourceRow[]
  assignments: SourceRow[]
  rotations: SourceRow[]
}
export async function readAttendanceCalc14UserPublicationV1(
  trx: AttendanceW4TransactionClientV1,
  input: {orgId:string;userId:string;workDate:string},
): Promise<AttendanceCalc14UserPublicationV1 | null> {
  const value=await readAttendanceCalc14SourceVersionV1(trx,{
    orgId:input.orgId,kind:'user_publication',sourceId:input.userId,workDate:input.workDate,
  })
  if (!object(value) || !rows(value.memberships) || !rows(value.assignments) || !rows(value.rotations)) return null
  if ([...value.assignments,...value.rotations].some(row=>row.org_id!==input.orgId || row.user_id!==input.userId)) return null
  if (value.memberships.some(row=>typeof row.id!=='string' || typeof row.group_id!=='string'
    || typeof row.effective_from!=='string' || (row.effective_to!==null && typeof row.effective_to!=='string'))) return null
  return {memberships:value.memberships,assignments:value.assignments,rotations:value.rotations}
}
export function attendanceCalc14MembershipsAtV1(source: AttendanceCalc14UserPublicationV1, workDate: string): SourceRow[] {
  return source.memberships.filter(row=>typeof row.effective_from==='string' && row.effective_from<=workDate
    && (row.effective_to===null || (typeof row.effective_to==='string' && row.effective_to>=workDate)))
}
export function attendanceCalc14PublishedSourcesAtV1(source: AttendanceCalc14UserPublicationV1, workDate: string): SourceRow[] {
  const at=(row:SourceRow) => (row.publish_status===null || row.publish_status==='published')
    && typeof row.start_date==='string' && row.start_date<=workDate
    && (row.end_date===null || (typeof row.end_date==='string' && row.end_date>=workDate))
  // Rotation is a separate attribution source; do not silently erase it just
  // because the strict group candidate is otherwise effective.
  return [...source.assignments.filter(at),...source.rotations.filter(at)]
}
