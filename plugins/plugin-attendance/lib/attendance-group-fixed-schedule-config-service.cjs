'use strict'

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

  return { upsertConfig, mapConfigRow }
}

module.exports = { createAttendanceGroupFixedScheduleConfigService }
