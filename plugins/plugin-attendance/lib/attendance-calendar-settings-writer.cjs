'use strict'

// A settings patch must never replay a cached calendar over a concurrent update.
function createAttendanceCalendarSettingsWriter({
  HttpError, settingsKey, defaultSettings, normalizeSettings, mergeSettings,
  isValidTimeZoneIdentifier, lockOrg, prepareSourceChange, saveSettings, cacheCommitted, assertManage,
}) {
  return async function updateSettings(db, patch, actor = null) {
    const saved = await db.transaction(async trx => {
      const verify = []
      if (patch.calendarPolicy?.overrides !== undefined) {
        const orgs = await trx.query(`SELECT org_id FROM user_orgs
          UNION SELECT org_id FROM attendance_rules ORDER BY org_id`)
        // Acquire ALL policy prefixes before any member, calendar or source row.
        for (const { org_id: orgId } of orgs) await lockOrg(trx, orgId)
        for (const { org_id: orgId } of orgs) {
          verify.push(await prepareSourceChange(trx, { orgId, userIds: null }))
        }
      }
      if (actor) {
        if (patch.calendarPolicy?.overrides === undefined) await lockOrg(trx, actor.orgId)
        await assertManage(trx, actor)
      }
      // Also serializes the absent-row case; status-only sync writes take this
      // lock after their source transaction, so cannot invert policy prefixes.
      await trx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [JSON.stringify(['attendance-settings-write-v1', settingsKey])])
      const rows = await trx.query('SELECT value FROM system_configs WHERE key=$1 FOR UPDATE', [settingsKey])
      let current = defaultSettings
      if (rows.length) {
        try {
          const raw = JSON.parse(rows[0].value)
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error()
          current = normalizeSettings(raw)
        } catch {
          throw new HttpError(503, 'ATTENDANCE_SETTINGS_SOURCE_INVALID', 'ATTENDANCE_SETTINGS_SOURCE_INVALID')
        }
      }
      const merged = mergeSettings(current, patch)
      // The original HTTP settings guard does not apply to trusted sync-status patches.
      if (actor && merged.annualLeavePolicy?.enabled === true) {
        if (!merged.annualLeavePolicy.timezone) {
          throw new HttpError(422, 'ANNUAL_LEAVE_TIMEZONE_REQUIRED',
            'annualLeavePolicy.timezone is required when annualLeavePolicy.enabled is true')
        }
        if (!isValidTimeZoneIdentifier(merged.annualLeavePolicy.timezone)) {
          throw new HttpError(422, 'ANNUAL_LEAVE_TIMEZONE_INVALID',
            'annualLeavePolicy.timezone must be a valid IANA timezone identifier')
        }
      }
      const result = await saveSettings(trx, merged, { updateCache: false })
      for (const check of verify) await check()
      return result
    })
    // Never expose rolled-back values through the process cache.
    cacheCommitted(saved)
    return saved
  }
}

module.exports = { createAttendanceCalendarSettingsWriter }
