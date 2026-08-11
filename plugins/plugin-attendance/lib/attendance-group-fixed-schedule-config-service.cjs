'use strict'

const CONFIG_CHANGED_ERROR_CODE = 'ATTENDANCE_FIXED_SCHEDULE_CONFIG_CHANGED'
const CONFIG_CHANGED_ERROR_MESSAGE = 'Fixed schedule desired configuration changed; reload the configuration and retry'

function createAttendanceGroupFixedScheduleConfigService({ HttpError }) {
  function formatDateOnly(value) {
    if (value instanceof Date) {
      return [value.getFullYear(), value.getMonth() + 1, value.getDate()]
        .map((part, index) => index === 0 ? String(part) : String(part).padStart(2, '0'))
        .join('-')
    }
    const normalized = String(value)
    const match = normalized.match(/^\d{4}-\d{2}-\d{2}/)
    return match ? match[0] : normalized
  }

  function mapConfigRow(row) {
    return {
      id: row.id,
      orgId: row.org_id,
      groupId: row.group_id,
      shiftId: row.shift_id,
      startDate: formatDateOnly(row.start_date),
      endDate: formatDateOnly(row.end_date),
      revision: Number(row.revision),
      updatedBy: row.updated_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  async function upsertConfig(trx, input) {
    const groupRows = await trx.query(
      'SELECT id FROM attendance_groups WHERE id = $1 AND org_id = $2 LIMIT 1',
      [input.groupId, input.orgId],
    )
    if (!groupRows.length) {
      throw new HttpError(404, 'NOT_FOUND', 'Group not found')
    }

    const shiftRows = await trx.query(
      'SELECT id FROM attendance_shifts WHERE id = $1 AND org_id = $2 FOR SHARE',
      [input.shiftId, input.orgId],
    )
    if (!shiftRows.length) {
      throw new HttpError(404, 'NOT_FOUND', 'Shift not found')
    }

    const rows = await trx.query(
      `INSERT INTO attendance_group_fixed_schedule_configs
         (org_id, group_id, shift_id, start_date, end_date, revision, updated_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 1, $6, now(), now())
       ON CONFLICT (org_id, group_id) DO UPDATE
       SET shift_id = EXCLUDED.shift_id,
           start_date = EXCLUDED.start_date,
           end_date = EXCLUDED.end_date,
           revision = CASE
             WHEN attendance_group_fixed_schedule_configs.shift_id IS DISTINCT FROM EXCLUDED.shift_id
               OR attendance_group_fixed_schedule_configs.start_date IS DISTINCT FROM EXCLUDED.start_date
               OR attendance_group_fixed_schedule_configs.end_date IS DISTINCT FROM EXCLUDED.end_date
             THEN attendance_group_fixed_schedule_configs.revision + 1
             ELSE attendance_group_fixed_schedule_configs.revision
           END,
           updated_by = CASE
             WHEN attendance_group_fixed_schedule_configs.shift_id IS DISTINCT FROM EXCLUDED.shift_id
               OR attendance_group_fixed_schedule_configs.start_date IS DISTINCT FROM EXCLUDED.start_date
               OR attendance_group_fixed_schedule_configs.end_date IS DISTINCT FROM EXCLUDED.end_date
             THEN EXCLUDED.updated_by
             ELSE attendance_group_fixed_schedule_configs.updated_by
           END,
           updated_at = CASE
             WHEN attendance_group_fixed_schedule_configs.shift_id IS DISTINCT FROM EXCLUDED.shift_id
               OR attendance_group_fixed_schedule_configs.start_date IS DISTINCT FROM EXCLUDED.start_date
               OR attendance_group_fixed_schedule_configs.end_date IS DISTINCT FROM EXCLUDED.end_date
             THEN now()
             ELSE attendance_group_fixed_schedule_configs.updated_at
           END
       RETURNING *`,
      [input.orgId, input.groupId, input.shiftId, input.startDate, input.endDate, input.updatedBy],
    )
    return mapConfigRow(rows[0])
  }

  function throwConfigChanged() {
    throw new HttpError(409, CONFIG_CHANGED_ERROR_CODE, CONFIG_CHANGED_ERROR_MESSAGE)
  }

  function configValuesMatchCandidate(row, input) {
    return String(row.shift_id) === String(input.shiftId)
      && formatDateOnly(row.start_date) === input.startDate
      && formatDateOnly(row.end_date) === input.endDate
  }

  // FSER-3 (#4709): apply/rebuild consume the desired config inside their write
  // transaction. Date and group validation precede the config lock; an existing row is
  // locked and checked for staleness before its authoritative shift and targets are
  // validated. On first create, candidate shift and non-empty target validation precede
  // every config write. The config lock always precedes any per-user target lock taken
  // by the caller. When no config exists, the validated candidate is
  // inserted with INSERT ... ON CONFLICT DO NOTHING and the winning row is reloaded
  // FOR UPDATE: an identical concurrent candidate continues idempotently, a different
  // one gets the typed 409 instead of a leaked uniqueness error. When a config exists,
  // a stale expectedConfigRevision or a legacy candidate value mismatch throws the same
  // typed 409 before any assignment/config write. The returned row is the only
  // authoritative source of the values the caller may materialize.
  async function resolveConfigForApplyRebuild(trx, input) {
    if (typeof input.startDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.startDate)
      || typeof input.endDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.endDate)
      || input.startDate > input.endDate) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'A valid startDate on or before endDate is required.')
    }

    const groupRows = await trx.query(
      'SELECT id FROM attendance_groups WHERE id = $1 AND org_id = $2 LIMIT 1',
      [input.groupId, input.orgId],
    )
    if (!groupRows.length) {
      throw new HttpError(404, 'NOT_FOUND', 'Group not found')
    }

    const lockedRows = await trx.query(
      `SELECT *
        FROM attendance_group_fixed_schedule_configs
       WHERE org_id = $1 AND group_id = $2
        FOR UPDATE`,
      [input.orgId, input.groupId],
    )
    if (lockedRows.length) {
      const locked = lockedRows[0]
      if (input.expectedConfigRevision !== undefined && input.expectedConfigRevision !== null) {
        if (Number(locked.revision) !== Number(input.expectedConfigRevision)) {
          throwConfigChanged()
        }
      } else if (!configValuesMatchCandidate(locked, input)) {
        throwConfigChanged()
      }
      const shiftRows = await trx.query(
        'SELECT id FROM attendance_shifts WHERE id = $1 AND org_id = $2 FOR SHARE',
        [locked.shift_id, input.orgId],
      )
      if (!shiftRows.length) {
        throw new HttpError(404, 'NOT_FOUND', 'Shift not found')
      }
      const targetRows = await trx.query(
        'SELECT 1 AS present FROM attendance_group_members WHERE org_id = $1 AND group_id = $2 LIMIT 1',
        [input.orgId, input.groupId],
      )
      if (!targetRows.length) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'Group has no members to schedule')
      }
      return { config: mapConfigRow(locked), created: false }
    }

    const shiftRows = await trx.query(
      'SELECT id FROM attendance_shifts WHERE id = $1 AND org_id = $2 FOR SHARE',
      [input.shiftId, input.orgId],
    )
    if (!shiftRows.length) {
      throw new HttpError(404, 'NOT_FOUND', 'Shift not found')
    }
    const targetRows = await trx.query(
      'SELECT 1 AS present FROM attendance_group_members WHERE org_id = $1 AND group_id = $2 LIMIT 1',
      [input.orgId, input.groupId],
    )
    if (!targetRows.length) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Group has no members to schedule')
    }

    const insertedRows = await trx.query(
      `INSERT INTO attendance_group_fixed_schedule_configs
         (org_id, group_id, shift_id, start_date, end_date, revision, updated_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 1, $6, now(), now())
       ON CONFLICT (org_id, group_id) DO NOTHING
       RETURNING id`,
      [input.orgId, input.groupId, input.shiftId, input.startDate, input.endDate, input.updatedBy ?? null],
    )
    const winnerRows = await trx.query(
      `SELECT *
         FROM attendance_group_fixed_schedule_configs
        WHERE org_id = $1 AND group_id = $2
        FOR UPDATE`,
      [input.orgId, input.groupId],
    )
    const winner = winnerRows[0]
    if (!winner) {
      throw new HttpError(409, CONFIG_CHANGED_ERROR_CODE, CONFIG_CHANGED_ERROR_MESSAGE)
    }
    if (!configValuesMatchCandidate(winner, input)) {
      throwConfigChanged()
    }
    return { config: mapConfigRow(winner), created: insertedRows.length > 0 }
  }

  return { upsertConfig, resolveConfigForApplyRebuild, mapConfigRow }
}

module.exports = {
  ATTENDANCE_FIXED_SCHEDULE_CONFIG_CHANGED: CONFIG_CHANGED_ERROR_CODE,
  createAttendanceGroupFixedScheduleConfigService,
}
