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
  const leaveHours = calc.leaveHours ?? calc.leave_hours
  const exceptionReason = calc.exceptionReason ?? calc.exception_reason

  const clockIn1 = record.clockIn1 ?? record.clock_in_1 ?? record['1_on_duty_user_check_time']
  const clockOut1 = record.clockOut1 ?? record.clock_out_1 ?? record['1_off_duty_user_check_time']
  const clockIn2 = record.clockIn2 ?? record.clock_in_2 ?? record['2_on_duty_user_check_time']
  const clockOut2 = record.clockOut2 ?? record.clock_out_2 ?? record['2_off_duty_user_check_time']

  const hasPunch = Boolean(clockIn1 || clockOut1 || clockIn2 || clockOut2)

  return {
    ...record,
    ...calc,
    approvals,
    approval: approvals,
    attendance_group: record.attendance_group ?? profile.attendance_group ?? profile.attendanceGroup,
    role_tags: profile.role_tags ?? profile.roleTags ?? [],
    department: profile.department,
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
      return Boolean(actual)
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
    if (key.endsWith('_after')) {
      const field = key.replace(/_after$/, '')
      const actual = facts[field]
      const diff = compareTime(actual, expected)
      return diff != null && diff > 0
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
  if (effects.warning) {
    result.warnings.push(effects.warning)
  }
  if (effects.reason) {
    result.reasons.push(effects.reason)
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
