'use strict'

const { canonicalContextFingerprint } = require('./attendance-timezone-runtime.cjs')

// Only a freshly computed default-only frame may target a date that already has
// one active, calculation-untracked record in the same zone and no companion.
function isPreCompanionLegacyTarget(frame, prior) {
  return prior.length === 1 && prior[0].current_calculation_id === null
    && prior[0].timezone === frame.timezone
    && frame.legacyRecordId === undefined && frame.legacyFrozenCalculationId === undefined
    && frame.timezoneContext?.mode === 'default_only'
    && frame.identity?.source !== 'legacy_repair' && frame.identity?.source !== 'frozen_v2'
}

// Admission also needs the persisted calculation posture to be legacy (no rollout
// row, or state legacy): in shadow/authoritative a write would append an immutable
// snapshot from today's rule, or move the record's current calculation, so the old
// date stays on the controlled repair path. Checked only after the pure test passes,
// so every other case issues exactly the queries it did before.
async function admitsPreCompanionLegacyTarget(trx, orgId, frame, prior) {
  if (!isPreCompanionLegacyTarget(frame, prior)) return false
  const rows = await trx.query('SELECT state FROM attendance_calculation_rollout_state WHERE org_id=$1',[orgId])
  return rows.length === 0 || (rows.length === 1 && rows[0].state === 'legacy')
}

// The fingerprint carries no org or user; key the unfrozen marker by the full target.
function targetKey(frame) {
  return JSON.stringify([frame.orgId,frame.userId,frame.workDate,frame.fingerprint])
}

function createAttendanceTimezoneCompanionStore({ HttpError, validateFrozenContext, validateFrozenAttribution }) {
  function fail(code, status = 409) { throw new HttpError(status, code, code) }
  function restore(row) {
    const frame = typeof row.frame_snapshot === 'string' ? JSON.parse(row.frame_snapshot) : row.frame_snapshot
    if (!frame || !frame.identity || canonicalContextFingerprint(frame.identity) !== frame.fingerprint
      || canonicalContextFingerprint(typeof row.original_freeze_snapshot === 'string'
        ? JSON.parse(row.original_freeze_snapshot) : row.original_freeze_snapshot) !== row.original_freeze_fingerprint
      || frame.fingerprint !== row.context_fingerprint || frame.timezone !== row.timezone
      || frame.orgId !== row.org_id || frame.userId !== row.user_id) fail('ATTENDANCE_TIMEZONE_FROZEN_CONTEXT_INVALID')
    function revive(value) {
      if (Array.isArray(value)) return value.map(revive)
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [
        key, ['startAt', 'endAt'].includes(key) && typeof item === 'string' ? new Date(item) : revive(item),
      ]))
      return value
    }
    return revive(frame)
  }
  const verifiedTargets = new WeakMap()
  const unboundTargets = new WeakMap()
  async function readEligibleOpen(trx, { orgId, userId, occurredAt }) {
    const rows = await trx.query(`SELECT c.*
      FROM attendance_timezone_context_companions c
      JOIN attendance_records r ON r.id=c.record_id AND r.org_id=c.org_id
      WHERE c.org_id=$1 AND c.user_id=$2 AND r.first_in_at IS NOT NULL AND r.last_out_at IS NULL
        AND r.visibility_state='active'
        AND c.attribution_start_at <= $3 AND $3 <= c.attribution_end_at`, [orgId,userId,occurredAt])
    if (rows.length > 1) fail('ATTENDANCE_TIMEZONE_OPEN_CONTEXT_AMBIGUOUS')
    return rows.length === 0 ? null : restore(rows[0])
  }
  async function readEligibleLegacyRepair(trx, { orgId, userId, occurredAt, eventType }) {
    const rows = await trx.query(`SELECT c.* FROM attendance_timezone_context_companions c
      JOIN attendance_records r ON r.id=c.record_id AND r.org_id=c.org_id
      WHERE c.org_id=$1 AND c.user_id=$2 AND r.visibility_state='active'
        AND c.frame_snapshot->'identity'->>'source'='legacy_repair'
        AND r.last_out_at IS NULL AND c.attribution_start_at <= $3
        AND $3 <= CASE WHEN $4='check_in' THEN c.absolute_end_at ELSE c.attribution_end_at END`,
    [orgId,userId,occurredAt,eventType])
    if (rows.length > 1) fail('ATTENDANCE_TIMEZONE_OPEN_CONTEXT_AMBIGUOUS')
    return rows.length === 0 ? null : restore(rows[0])
  }
  async function readLegacyFrozenV2(trx,{orgId,userId,workDate = null,occurredAt = null,workDates}) {
    const rows = await trx.query(`SELECT r.id,r.org_id,r.user_id,r.work_date::text,r.timezone,r.current_calculation_id,
      calc.context_snapshot,calc.attribution_snapshot,calc.source_definition_fingerprint
      FROM attendance_records r
      JOIN attendance_record_calculations calc ON calc.id=r.current_calculation_id
        AND calc.attendance_record_id=r.id AND calc.org_id=r.org_id
      LEFT JOIN attendance_timezone_context_companions c ON c.record_id=r.id AND c.org_id=r.org_id
      WHERE r.org_id=$1 AND r.user_id=$2 AND r.visibility_state='active' AND c.record_id IS NULL
        AND ($3::date IS NULL OR r.work_date=$3::date)
        AND ($4::boolean=false OR (r.first_in_at IS NOT NULL AND r.last_out_at IS NULL))
        AND ($5::date[] IS NULL OR r.work_date=ANY($5::date[]))
         AND calc.attribution_snapshot->>'posture'='resolved_v2'`,
    [orgId,userId,workDate,occurredAt !== null,workDates ?? null])
    const frames = []
    for (const row of rows) {
      const context = typeof row.context_snapshot === 'string' ? JSON.parse(row.context_snapshot) : row.context_snapshot
      const attribution = typeof row.attribution_snapshot === 'string' ? JSON.parse(row.attribution_snapshot) : row.attribution_snapshot
      const frozen = attribution?.value
      const absoluteWindow = {startAt:new Date(frozen?.absoluteWindow?.startAt),endAt:new Date(frozen?.absoluteWindow?.endAt)}
      const attributionWindow = {startAt:new Date(frozen?.attributionWindow?.startAt),endAt:new Date(frozen?.attributionWindow?.endAt)}
      if (![absoluteWindow.startAt,absoluteWindow.endAt,attributionWindow.startAt,attributionWindow.endAt]
        .every(value=>Number.isFinite(value.getTime()))) fail('ATTENDANCE_TIMEZONE_FROZEN_CONTEXT_INVALID')
      if (occurredAt !== null && (occurredAt<attributionWindow.startAt || attributionWindow.endAt<occurredAt)) continue
      if (!validateFrozenContext(context) || !validateFrozenAttribution(attribution)
        || context.orgId !== orgId || context.userId !== userId || context.workDate !== row.work_date
        || context.timezone !== row.timezone || frozen.orgId !== orgId || frozen.userId !== userId
        || frozen.workDate !== row.work_date || frozen.shiftId !== context.shiftId) {
        fail('ATTENDANCE_TIMEZONE_FROZEN_CONTEXT_INVALID')
      }
      const first = context.segments[0],last = context.segments[context.segments.length-1]
      const rule = {
        id:context.shiftId,orgId,timezone:context.timezone,workStartTime:first.startTime,workEndTime:last.endTime,
        isOvernight:last.endDayOffset === 1,lateGraceMinutes:first.lateGraceMinutes,
        earlyGraceMinutes:last.earlyLeaveGraceMinutes,roundingMinutes:context.roundingMinutes,
        severeLateThresholdMinutes:context.severeLateThresholdMinutes,
        absenceLateThresholdMinutes:context.absenceLateThresholdMinutes,
        workingDays:context.isWorkday ? [0,1,2,3,4,5,6] : [],
      }
      const resolution = {
        kind:'resolved',workDate:row.work_date,shiftId:context.shiftId,segmentIndex:null,
        reasonCode:frozen.reasonCode,evidenceSnapshot:null,frozenAttribution:attribution,
        attributionTailMinutes:frozen.attributionTailMinutes,approvedOvertimeWindows:[],
        fullWinner:{workDate:row.work_date,shiftId:context.shiftId,source:'frozen_v2',assignmentId:null,
          isOvernight:rule.isOvernight,timezone:context.timezone,workStartTime:rule.workStartTime,
          workEndTime:rule.workEndTime,absoluteWindow,attributionWindow},
      }
      const identity = {
        workDate:row.work_date,shiftId:context.shiftId,source:'frozen_v2',
        originalRecordId:row.id,originalCalculationId:row.current_calculation_id,
        calculationDefinition:context,frozenAttribution:attribution,timezone:context.timezone,timezoneContext:null,
      }
      frames.push({
        recordId:row.id,frame:{
          orgId,userId,workDate:row.work_date,timezone:context.timezone,timezoneContext:null,
          context:{rule,isWorkingDay:context.isWorkday,source:'frozen_v2',assignment:null,rotation:null,rotationAssignment:null,holiday:null},
          resolution,identity,absoluteWindow,attributionWindow,
          fingerprint:canonicalContextFingerprint(identity),legacyRecordId:row.id,
          legacyFrozenCalculationId:row.current_calculation_id,
          issued:{arm:context.schemaVersion === 2 ? 'group' : 'legacy',context,reason:null},
        },
      })
    }
    if (workDates !== undefined) return frames
    if (frames.length>1) fail('ATTENDANCE_TIMEZONE_OPEN_CONTEXT_AMBIGUOUS')
    return frames.length === 0 ? null : frames[0]
  }
  async function readForWorkDate(trx,{orgId,userId,workDate}) {
    const rows = await trx.query(`SELECT c.* FROM attendance_timezone_context_companions c
      JOIN attendance_records r ON r.id=c.record_id AND r.org_id=c.org_id
      WHERE c.org_id=$1 AND c.user_id=$2 AND c.work_date=$3 AND r.visibility_state='active'`,[orgId,userId,workDate])
    if (rows.length > 1) fail('ATTENDANCE_TIMEZONE_FROZEN_CONTEXT_INVALID')
    return rows.length === 0 ? null : {recordId:rows[0].record_id,frame:restore(rows[0])}
  }
  async function readForWorkDates(trx,{orgId,userId,workDates}) {
    const rows = await trx.query(`SELECT c.*,c.work_date::text AS target_work_date
      FROM attendance_timezone_context_companions c
      JOIN attendance_records r ON r.id=c.record_id AND r.org_id=c.org_id
      WHERE c.org_id=$1 AND c.user_id=$2 AND c.work_date=ANY($3::date[]) AND r.visibility_state='active'`,
    [orgId,userId,workDates])
    const entries = new Map()
    for (const row of rows) {
      if (!workDates.includes(row.target_work_date) || entries.has(row.target_work_date)) fail('ATTENDANCE_TIMEZONE_FROZEN_CONTEXT_INVALID')
      entries.set(row.target_work_date,{recordId:row.record_id,frame:restore(row)})
    }
    return entries
  }
  async function assertTarget(trx, frame) {
    const rows = await trx.query(
      'SELECT * FROM attendance_timezone_context_companions WHERE org_id=$1 AND user_id=$2 AND work_date=$3',
      [frame.orgId,frame.userId,frame.workDate],
    )
    if (rows.length > 1) fail('ATTENDANCE_TIMEZONE_FROZEN_CONTEXT_INVALID')
    if (rows.length === 1 && rows[0].context_fingerprint !== frame.fingerprint) {
      fail('ATTENDANCE_TIMEZONE_WORK_DATE_CONTEXT_CONFLICT')
    }
    let unbound = false
    if (rows.length === 0) {
      const prior = await trx.query(`SELECT id,timezone,current_calculation_id FROM attendance_records
        WHERE org_id=$1 AND user_id=$2 AND work_date=$3 AND visibility_state='active'`,[frame.orgId,frame.userId,frame.workDate])
      if (prior.length && !(prior.length === 1 && prior[0].id === frame.legacyRecordId
        && prior[0].current_calculation_id === frame.legacyFrozenCalculationId)) {
        // A pre-companion freeze cannot be rebound from today's mutable rule/version.
        // With multi-timezone OFF, an untracked pre-upgrade record in the same zone
        // keeps its pre-upgrade behaviour: computed now, and never frozen.
        unbound = await admitsPreCompanionLegacyTarget(trx, frame.orgId, frame, prior)
        if (!unbound) fail('ATTENDANCE_TIMEZONE_FROZEN_CONTEXT_MIGRATION_REQUIRED')
      }
    }
    verifiedTargets.set(trx,frame.fingerprint)
    if (unbound) unboundTargets.set(trx,targetKey(frame))
    else unboundTargets.delete(trx)
  }
  async function bindFirst(trx, frame, { calculationId = null } = {}) {
    if (verifiedTargets.get(trx) !== frame.fingerprint) fail('ATTENDANCE_TIMEZONE_CONTEXT_UNPREPARED',503)
    if (unboundTargets.get(trx) === targetKey(frame)) return
    const existing = await trx.query(
      'SELECT record_id FROM attendance_timezone_context_companions WHERE org_id=$1 AND user_id=$2 AND work_date=$3',
      [frame.orgId,frame.userId,frame.workDate],
    )
    if (existing.length) return
    const records = await trx.query(`SELECT id,timezone,meta,current_calculation_id
      FROM attendance_records WHERE org_id=$1 AND user_id=$2 AND work_date=$3`,
    [frame.orgId,frame.userId,frame.workDate])
    if (records.length !== 1 || records[0].timezone !== frame.timezone) fail('ATTENDANCE_TIMEZONE_FROZEN_REFERENCE_INVALID')
    const record = records[0]
    const originalCalculationId = frame.legacyFrozenCalculationId ?? calculationId ?? record.current_calculation_id
    const calculations = originalCalculationId
      ? await trx.query(`SELECT id,context_snapshot,attribution_snapshot,source_definition_fingerprint
          FROM attendance_record_calculations WHERE id=$1 AND attendance_record_id=$2 AND org_id=$3`,
      [originalCalculationId,record.id,frame.orgId]) : []
    if (originalCalculationId && calculations.length !== 1) fail('ATTENDANCE_TIMEZONE_FROZEN_REFERENCE_INVALID')
    const originalFreeze = calculations.length === 1 ? { calculation: calculations[0] }
      : { recordId: record.id, meta: record.meta, rule: frame.context.rule, resolution: frame.resolution }
    await trx.query(`INSERT INTO attendance_timezone_context_companions
      (record_id,org_id,user_id,work_date,timezone,absolute_start_at,absolute_end_at,
       attribution_start_at,attribution_end_at,context_fingerprint,original_freeze_fingerprint,
       original_calculation_id,frame_snapshot,original_freeze_snapshot)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb)`,
    [record.id,frame.orgId,frame.userId,frame.workDate,frame.timezone,frame.absoluteWindow.startAt,frame.absoluteWindow.endAt,
      frame.attributionWindow.startAt,frame.attributionWindow.endAt,frame.fingerprint,
      canonicalContextFingerprint(originalFreeze),calculations[0]?.id ?? null,JSON.stringify(frame),JSON.stringify(originalFreeze)])
  }
  return { readLegacyFrozenV2, readEligibleLegacyRepair, readEligibleOpen, readForWorkDate, readForWorkDates, assertTarget, bindFirst }
}

module.exports = { createAttendanceTimezoneCompanionStore, isPreCompanionLegacyTarget, admitsPreCompanionLegacyTarget }
