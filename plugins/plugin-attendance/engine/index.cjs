const { DEFAULT_TEMPLATES } = require('./template-library.cjs')
const { validateConfig } = require('./schema.cjs')

function createRuleEngine({ config, logger } = {}) {
  const normalized = validateConfig(config ?? {})
  const templates = Array.isArray(normalized.templates) && normalized.templates.length
    ? normalized.templates
    : DEFAULT_TEMPLATES
  const templateIndex = new Map(templates.map((template) => [template.name, template]))

  const selectedTemplateNames = []
  const templateName = typeof normalized.templateName === 'string' ? normalized.templateName.trim() : ''
  const templateNames = Array.isArray(normalized.templateNames) ? normalized.templateNames : []
  if (templateName) selectedTemplateNames.push(templateName)
  templateNames.forEach((name) => {
    if (typeof name === 'string' && name.trim()) selectedTemplateNames.push(name.trim())
  })

  if (selectedTemplateNames.length === 0) {
    templates.forEach((template) => {
      if (template?.isDefault || template?.default) selectedTemplateNames.push(template.name)
    })
  }

  const rules = []
  selectedTemplateNames.forEach((name) => {
    const template = templateIndex.get(name)
    if (template?.rules?.length) rules.push(...template.rules)
  })
  if (Array.isArray(normalized.rules)) rules.push(...normalized.rules)

  return {
    evaluate(input) {
      try {
        return evaluateRules(rules, input)
      } catch (error) {
        if (logger?.warn) logger.warn('Attendance rule engine evaluate failed', error)
        return { appliedRules: [], warnings: ['Engine evaluation failed'], reasons: [] }
      }
    },
  }
}

function evaluateRules(rules, input) {
  const context = normalizeInput(input)
  const appliedRules = []
  const warnings = []
  const reasons = []
  const overrides = {}

  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index]
    if (!rule || typeof rule !== 'object') continue
    const when = rule.when ?? rule.if ?? {}
    if (!matchWhen(when, context)) continue

    const name = typeof rule.name === 'string' && rule.name.trim()
      ? rule.name.trim()
      : `rule-${appliedRules.length + 1}`
    appliedRules.push(name)

    const then = rule.then ?? rule.action ?? {}
    const result = applyActions(then, overrides, warnings, reasons)
    if (result.stop) break
    if (rule.stopOnMatch || rule.stop) break
  }

  return {
    appliedRules,
    warnings,
    reasons,
    ...overrides,
  }
}

function normalizeInput(input) {
  return {
    record: input?.record ?? {},
    profile: input?.profile ?? {},
    approvals: input?.approvals ?? [],
    calc: input?.calc ?? {},
  }
}

function matchWhen(when, context) {
  if (!when || typeof when !== 'object') return true
  if (Array.isArray(when.all)) {
    return when.all.every((cond) => matchWhen(cond, context))
  }
  if (Array.isArray(when.any)) {
    return when.any.some((cond) => matchWhen(cond, context))
  }
  if (when.not) {
    return !matchWhen(when.not, context)
  }

  if (when.fieldEquals || when.fieldContains || when.fieldIn || when.fieldNumberGte || when.fieldNumberLte) {
    if (when.fieldEquals && !matchFieldEquals(when.fieldEquals, context)) return false
    if (when.fieldContains && !matchFieldContains(when.fieldContains, context)) return false
    if (when.fieldIn && !matchFieldIn(when.fieldIn, context)) return false
    if (when.fieldNumberGte && !matchFieldNumber(when.fieldNumberGte, context, 'gte')) return false
    if (when.fieldNumberLte && !matchFieldNumber(when.fieldNumberLte, context, 'lte')) return false
    return true
  }

  if (Array.isArray(when.userIds)) {
    const userId = context.record?.userId ?? context.profile?.userId
    if (!userId || !when.userIds.includes(userId)) return false
  }

  if (when.field || when.op) {
    return matchCondition(when, context)
  }

  return Object.entries(when).every(([key, value]) => matchCondition({ field: key, op: 'eq', value }, context))
}

function matchFieldEquals(map, context) {
  return Object.entries(map).every(([field, expected]) => {
    const value = resolveField(context, field)
    return value == expected
  })
}

function matchFieldContains(map, context) {
  return Object.entries(map).every(([field, expected]) => {
    const value = resolveField(context, field)
    if (value == null) return false
    if (Array.isArray(value)) return value.map(String).includes(String(expected))
    return String(value).includes(String(expected))
  })
}

function matchFieldIn(map, context) {
  return Object.entries(map).every(([field, expected]) => {
    if (!Array.isArray(expected)) return false
    const value = resolveField(context, field)
    return expected.includes(value)
  })
}

function matchFieldNumber(map, context, op) {
  return Object.entries(map).every(([field, expected]) => {
    const value = Number(resolveField(context, field))
    const target = Number(expected)
    if (!Number.isFinite(value) || !Number.isFinite(target)) return false
    return op === 'gte' ? value >= target : value <= target
  })
}

function matchCondition(condition, context) {
  const field = String(condition.field ?? '').trim()
  const op = String(condition.op ?? 'eq').trim()
  const expected = condition.value
  const value = resolveField(context, field)

  switch (op) {
    case 'exists':
      return value !== undefined && value !== null && value !== ''
    case 'truthy':
      return Boolean(value)
    case 'falsy':
      return !value
    case 'neq':
      return value != expected
    case 'in':
      return Array.isArray(expected) ? expected.includes(value) : false
    case 'contains':
      if (value == null) return false
      if (Array.isArray(value)) return value.map(String).includes(String(expected))
      return String(value).includes(String(expected))
    case 'gte':
      return Number(value) >= Number(expected)
    case 'lte':
      return Number(value) <= Number(expected)
    case 'gt':
      return Number(value) > Number(expected)
    case 'lt':
      return Number(value) < Number(expected)
    case 'regex': {
      const pattern = typeof expected === 'string' ? expected : ''
      if (!pattern) return false
      const re = new RegExp(pattern)
      return re.test(String(value ?? ''))
    }
    case 'eq':
    default:
      return value == expected
  }
}

function resolveField(context, field) {
  if (!field) return undefined
  if (field.includes('.')) {
    return field.split('.').reduce((acc, key) => (acc ? acc[key] : undefined), context)
  }
  if (context.record && field in context.record) return context.record[field]
  if (context.profile && field in context.profile) return context.profile[field]
  if (context.calc && field in context.calc) return context.calc[field]
  if (field in context) return context[field]
  return undefined
}

function applyActions(actions, overrides, warnings, reasons) {
  if (!actions || typeof actions !== 'object') return { stop: false }

  const set = actions.set ?? {}
  const applyNumber = (targetKey, value) => {
    if (Number.isFinite(value)) overrides[targetKey] = Number(value)
  }

  applyNumber('actual_hours', set.actual_hours ?? actions.actual_hours)
  applyNumber('overtime_hours', set.overtime_hours ?? actions.overtime_hours)
  applyNumber('required_hours', set.required_hours ?? actions.required_hours)

  const warn = actions.warn ?? actions.warning ?? null
  if (typeof warn === 'string' && warn.trim()) warnings.push(warn.trim())
  if (Array.isArray(actions.warnings)) {
    warnings.push(...actions.warnings.map((item) => String(item).trim()).filter(Boolean))
  }

  const reason = actions.reason ?? null
  if (typeof reason === 'string' && reason.trim()) reasons.push(reason.trim())
  if (Array.isArray(actions.reasons)) {
    reasons.push(...actions.reasons.map((item) => String(item).trim()).filter(Boolean))
  }

  return { stop: Boolean(actions.stop) }
}

module.exports = {
  createRuleEngine,
}
