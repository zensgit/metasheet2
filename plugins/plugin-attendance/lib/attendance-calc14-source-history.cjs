'use strict'

const CAPTURE_TRIGGERS = [
  'attendance_groups', 'attendance_group_fixed_schedule_configs', 'attendance_shifts',
  'attendance_shift_segments', 'attendance_rules', 'attendance_rule_sets', 'attendance_group_members', 'attendance_shift_assignments',
  'attendance_rotation_assignments', 'attendance_calculation_group_memberships',
  'attendance_holidays', 'attendance_timezone_policies', 'system_configs',
].map(table => `calc14_capture_${table}`).join(', ')

function calc14HttpError(error, HttpError) {
  if (error instanceof HttpError) return error
  if (error?.code !== '23514' || typeof error.message !== 'string') return error
  const codes = {
    ATTENDANCE_CALC14_EFFECTIVE_DATE_REQUIRED: 422,
    ATTENDANCE_CALC14_SOURCE_DATE_CONFLICT: 409,
    ATTENDANCE_CALC14_SOURCE_SCOPE_INVALID: 403,
    ATTENDANCE_CALC14_SOURCE_IMMUTABLE: 409,
  }
  const status = codes[error.message]
  return status ? new HttpError(status, error.message, error.message) : error
}

function createAttendanceCalc14SourceHistory({ HttpError, resolveGroupArm, loadDefaultRule, toWorkDate, assertOrdinaryBusinessEffectiveDate, now = () => new Date() }) {
  async function prepare(trx, { orgId, businessEffectiveDate, actorId }) {
    const arm = await resolveGroupArm(trx, orgId)
    const required = arm.effectiveState !== undefined && arm.effectiveState !== 'off'
    // OFF input without the new field does not depend on the new storage schema.
    if (!required) return async () => {}
    if (businessEffectiveDate !== undefined) {
      const rule = await loadDefaultRule(trx, orgId)
      // Missing/invalid timezone is a missing source, never a server-local date.
      if (typeof rule?.timezone !== 'string' || !rule.timezone) {
        throw new HttpError(422, 'ATTENDANCE_CALC14_SOURCE_HISTORY_INCOMPLETE', 'ATTENDANCE_CALC14_SOURCE_HISTORY_INCOMPLETE')
      }
      const at = now()
      try { new Intl.DateTimeFormat('en', { timeZone: rule.timezone }).format(at) }
      catch { throw new HttpError(422, 'ATTENDANCE_CALC14_SOURCE_HISTORY_INCOMPLETE', 'ATTENDANCE_CALC14_SOURCE_HISTORY_INCOMPLETE') }
      assertOrdinaryBusinessEffectiveDate(businessEffectiveDate, toWorkDate(at, rule.timezone))
    }
    if (businessEffectiveDate !== undefined) {
      const context = await trx.query(`SELECT nullif(current_setting('metasheet.calc14_org',true),'') AS org_id,
        nullif(current_setting('metasheet.calc14_business_effective_date',true),'') AS effective_date`, [])
      if ((context[0]?.org_id && context[0].org_id !== orgId)
        || (context[0]?.effective_date && context[0].effective_date !== businessEffectiveDate)) {
        throw new HttpError(409,'ATTENDANCE_CALC14_SOURCE_DATE_CONFLICT','ATTENDANCE_CALC14_SOURCE_DATE_CONFLICT')
      }
    }
    await trx.query(`SELECT set_config('metasheet.calc14_org',$1,true),
      set_config('metasheet.calc14_date_required',$2,true)`, [orgId, required ? 'true' : 'false'])
    if (businessEffectiveDate !== undefined) {
      await trx.query(`SELECT set_config('metasheet.calc14_business_effective_date',$1,true),
        set_config('metasheet.calc14_actor',$2,true)`, [businessEffectiveDate, actorId ?? ''])
    }
    return async () => {
      try {
        // Flush final source state before existing current-window guards read it.
        await trx.query(`SET CONSTRAINTS ${CAPTURE_TRIGGERS} IMMEDIATE`, [])
        await trx.query(`SET CONSTRAINTS ${CAPTURE_TRIGGERS} DEFERRED`, [])
      } catch (error) { throw calc14HttpError(error, HttpError) }
    }
  }
  return { prepare }
}

// Advisory read metadata only. Existing route authorization still owns access.
function createAttendanceCalc14CapabilityReader({ HttpError, resolveGroupArm }) {
  function unavailable() {
    throw new HttpError(503, 'ATTENDANCE_CALC14_SOURCE_POSTURE_UNAVAILABLE', 'ATTENDANCE_CALC14_SOURCE_POSTURE_UNAVAILABLE')
  }
  function assertItemOrg(item, orgId) {
    if (!item || item.orgId !== orgId) {
      throw new HttpError(403, 'ATTENDANCE_CALC14_SOURCE_SCOPE_INVALID', 'ATTENDANCE_CALC14_SOURCE_SCOPE_INVALID')
    }
  }
  async function requirementForOrg(trx, orgId) {
    if (typeof orgId !== 'string' || !orgId) {
      throw new HttpError(403, 'ATTENDANCE_CALC14_SOURCE_SCOPE_INVALID', 'ATTENDANCE_CALC14_SOURCE_SCOPE_INVALID')
    }
    let arm
    try { arm = await resolveGroupArm(trx, orgId) } catch { unavailable() }
    if (!arm || !['off', 'group_shadow', 'group_eligible', 'group_authoritative', 'suspended'].includes(arm.effectiveState)
      || typeof arm.selectsGroupArm !== 'boolean'
      || arm.selectsGroupArm !== (arm.effectiveState === 'group_authoritative')) unavailable()
    return arm.effectiveState !== 'off'
  }
  function addCapability(item) {
    if (item.capabilities !== undefined && (!item.capabilities || typeof item.capabilities !== 'object' || Array.isArray(item.capabilities))) unavailable()
    return { ...item, capabilities: { ...item.capabilities, businessEffectiveDateRequired: true } }
  }
  async function decorateItems(trx, { orgId, items }) {
    for (const item of items) assertItemOrg(item, orgId)
    if (items.length === 0) return items
    const required = await requirementForOrg(trx, orgId)
    return required ? items.map(addCapability) : items
  }
  async function decorateOrgData(trx, { orgId, data }) {
    const required = await requirementForOrg(trx, orgId)
    // Preserve the existing OFF fallback response exactly. An active source may
    // never advertise another organization's fallback rule as its own policy.
    if (!required) return data
    assertItemOrg(data, orgId)
    return addCapability(data)
  }
  return { requirementForOrg, decorateItems, decorateOrgData }
}

module.exports = { calc14HttpError, createAttendanceCalc14SourceHistory, createAttendanceCalc14CapabilityReader }
