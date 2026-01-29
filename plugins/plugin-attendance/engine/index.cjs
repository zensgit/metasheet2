const { validateConfig } = require('./schema.cjs')

function toMinutes(value) {
  if (!value || typeof value !== 'string') return null
  const parts = value.trim().split(':')
  if (parts.length < 2) return null
  const hours = Number(parts[0])
  const minutes = Number(parts[1])
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null
  return hours * 60 + minutes
}

function compareTime(left, right) {
  const leftMinutes = toMinutes(left)
  const rightMinutes = toMinutes(right)
  if (leftMinutes == null || rightMinutes == null) return null
  return leftMinutes - rightMinutes
}

function buildFacts(input) {
  const record = input?.record ?? {}
  const profile = input?.profile ?? {}
  const calc = input?.calc ?? {}
  const approvals = input?.approvals ?? []
  const leaveHours = calc.leaveHours ?? calc.leave_hours ?? record.leave_hours
  const exceptionReason =
    calc.exceptionReason ?? calc.exception_reason ?? record.exceptionReason ?? record.exception_reason

  const approvalSummary =
    record.approvalSummary ??
    record.approval_summary ??
    record.attendance_approve ??
    record.attendanceApprove ??
    record.approval
  const approval = approvals.length ? approvals : approvalSummary ?? record.approval

  const clockIn1 = record.clockIn1 ?? record.clock_in_1 ?? record['1_on_duty_user_check_time']
  const clockOut1 = record.clockOut1 ?? record.clock_out_1 ?? record['1_off_duty_user_check_time']
  const clockIn2 = record.clockIn2 ?? record.clock_in_2 ?? record['2_on_duty_user_check_time']
  const clockOut2 = record.clockOut2 ?? record.clock_out_2 ?? record['2_off_duty_user_check_time']

  const hasPunch = Boolean(clockIn1 || clockOut1 || clockIn2 || clockOut2)

  return {
    ...record,
    ...calc,
    approvals,
    approval,
    approvalSummary,
    attendance_group:
      record.attendance_group ??
      record.attendanceGroup ??
      profile.attendance_group ??
      profile.attendanceGroup,
    role_tags: profile.role_tags ?? profile.roleTags ?? [],
    role: profile.role ?? record.role,
    department: profile.department ?? record.department,
    shift: record.shift ?? record.plan_detail,
    clockIn1,
    clockOut1,
    clockIn2,
    clockOut2,
    has_punch: hasPunch,
    leave_hours: leaveHours,
    exceptionReason,
  }
}

function matchesScope(scope, facts) {
  if (!scope) return true
  return Object.entries(scope).every(([key, expected]) => {
    const actual = facts[key]
    if (key === 'role_tags') {
      if (!Array.isArray(actual) || !Array.isArray(expected)) return false
      return expected.some((tag) => actual.includes(tag))
    }
    if (Array.isArray(expected)) {
      return expected.includes(actual)
    }
    return actual === expected
  })
}

function matchesWhen(when, facts) {
  return Object.entries(when).every(([key, expected]) => {
    if (key === 'role') {
      if (facts.role === expected) return true
      if (Array.isArray(facts.role_tags)) {
        return facts.role_tags.includes(expected)
      }
      return false
    }
    if (key.endsWith('_exists')) {
      const field = key.replace(/_exists$/, '')
      const actual = facts[field]
      const exists = Boolean(actual)
      if (expected === false) return !exists
      return exists
    }
    if (key.endsWith('_contains_any')) {
      const field = key.replace(/_contains_any$/, '')
      const actual = facts[field]
      if (Array.isArray(expected)) {
        if (Array.isArray(actual)) {
          return expected.some((value) => actual.includes(value))
        }
        if (typeof actual === 'string') {
          return expected.some((value) => actual.includes(String(value)))
        }
        return false
      }
      if (Array.isArray(actual)) return actual.includes(expected)
      if (typeof actual === 'string') return actual.includes(String(expected))
      return false
    }
    if (key.endsWith('_not_contains')) {
      const field = key.replace(/_not_contains$/, '')
      const actual = facts[field]
      if (actual == null || actual === '') return true
      if (Array.isArray(expected)) {
        if (Array.isArray(actual)) {
          return expected.every((value) => !actual.includes(value))
        }
        if (typeof actual === 'string') {
          return expected.every((value) => !actual.includes(String(value)))
        }
        return false
      }
      if (Array.isArray(actual)) return !actual.includes(expected)
      if (typeof actual === 'string') return !actual.includes(String(expected))
      return false
    }
    if (key.endsWith('_contains')) {
      const field = key.replace(/_contains$/, '')
      const actual = facts[field]
      if (Array.isArray(expected)) {
        if (Array.isArray(actual)) {
          return expected.every((value) => actual.includes(value))
        }
        if (typeof actual === 'string') {
          return expected.every((value) => actual.includes(String(value)))
        }
        return false
      }
      if (Array.isArray(actual)) return actual.includes(expected)
      if (typeof actual === 'string') return actual.includes(String(expected))
      return false
    }
    if (key.endsWith('_before')) {
      const field = key.replace(/_before$/, '')
      const actual = facts[field]
      const diff = compareTime(actual, expected)
      return diff != null && diff < 0
    }
    if (key.endsWith('_after')) {
      const field = key.replace(/_after$/, '')
      const actual = facts[field]
      const diff = compareTime(actual, expected)
      return diff != null && diff > 0
    }
    if (key.endsWith('_gt')) {
      const field = key.replace(/_gt$/, '')
      const actual = Number(facts[field])
      if (!Number.isFinite(actual)) return false
      return actual > Number(expected)
    }
    if (key.endsWith('_lt')) {
      const field = key.replace(/_lt$/, '')
      const actual = Number(facts[field])
      if (!Number.isFinite(actual)) return false
      return actual < Number(expected)
    }
    if (key.endsWith('_gte')) {
      const field = key.replace(/_gte$/, '')
      const actual = Number(facts[field])
      if (!Number.isFinite(actual)) return false
      return actual >= Number(expected)
    }
    if (key.endsWith('_lte')) {
      const field = key.replace(/_lte$/, '')
      const actual = Number(facts[field])
      if (!Number.isFinite(actual)) return false
      return actual <= Number(expected)
    }
    if (key.endsWith('_eq')) {
      const field = key.replace(/_eq$/, '')
      return facts[field] === expected
    }
    if (key.endsWith('_ne')) {
      const field = key.replace(/_ne$/, '')
      return facts[field] !== expected
    }
    if (expected === true || expected === false) {
      return Boolean(facts[key]) === expected
    }
    if (Array.isArray(expected)) {
      return expected.includes(facts[key])
    }
    return facts[key] === expected
  })
}

function applyEffects(result, effects) {
  const pushUnique = (list, value) => {
    if (!value) return
    if (!list.includes(value)) list.push(value)
  }
  if (typeof effects.overtime_hours === 'number') {
    result.overtime_hours = effects.overtime_hours
  }
  if (typeof effects.overtime_add === 'number') {
    const current = Number(result.overtime_hours ?? 0)
    result.overtime_hours = current + effects.overtime_add
  }
  if (typeof effects.required_hours === 'number') {
    result.required_hours = effects.required_hours
  }
  if (typeof effects.actual_hours === 'number') {
    result.actual_hours = effects.actual_hours
  }
  if (Array.isArray(effects.warnings)) {
    effects.warnings.filter(Boolean).forEach((warning) => pushUnique(result.warnings, warning))
  }
  if (Array.isArray(effects.reasons)) {
    effects.reasons.filter(Boolean).forEach((reason) => pushUnique(result.reasons, reason))
  }
  if (effects.warning) {
    pushUnique(result.warnings, effects.warning)
  }
  if (effects.reason) {
    pushUnique(result.reasons, effects.reason)
  }
}

function createRuleEngine({ config, logger } = {}) {
  const normalized = validateConfig(config)
  const log = logger ?? console

  return {
    config: normalized,
    evaluate(input) {
      const facts = buildFacts(input)
      const output = {
        facts,
        overtime_hours: facts.overtime_hours ?? 0,
        required_hours: facts.required_hours ?? facts.requiredAttendanceHours ?? 0,
        actual_hours: facts.actual_hours ?? facts.actualAttendanceHours ?? 0,
        warnings: [],
        reasons: [],
        appliedRules: [],
      }

      for (const template of normalized.templates) {
        if (!matchesScope(template.scope, facts)) continue
        for (const rule of template.rules) {
          if (!matchesWhen(rule.when, facts)) continue
          applyEffects(output, rule.then)
          output.appliedRules.push(rule.id)
        }
      }

      log.debug?.('attendance rule engine evaluated', {
        appliedRules: output.appliedRules,
      })
      return output
    },
  }
}

module.exports = {
  createRuleEngine,
  buildFacts,
  matchesWhen,
}
