function buildError(details) {
  const error = new Error('Invalid engine config')
  error.details = details
  return error
}

function normalizeTemplate(template, index, details) {
  if (!template || typeof template !== 'object') {
    details.push({ path: `templates[${index}]`, message: 'Template must be an object' })
    return null
  }
  const name = String(template.name ?? '').trim()
  if (!name) {
    details.push({ path: `templates[${index}].name`, message: 'name is required' })
    return null
  }
  const rules = Array.isArray(template.rules) ? template.rules : []
  return {
    ...template,
    name,
    rules,
  }
}

function normalizeRules(rules, details) {
  if (!Array.isArray(rules)) {
    details.push({ path: 'rules', message: 'rules must be an array' })
    return []
  }
  return rules.filter((rule) => rule && typeof rule === 'object')
}

function validateConfig(config) {
  const details = []
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw buildError([{ path: 'config', message: 'config must be an object' }])
  }

  const normalized = { ...config }

  if ('templates' in config) {
    if (!Array.isArray(config.templates)) {
      details.push({ path: 'templates', message: 'templates must be an array' })
      normalized.templates = []
    } else {
      normalized.templates = config.templates
        .map((template, index) => normalizeTemplate(template, index, details))
        .filter(Boolean)
    }
  }

  if ('rules' in config) {
    normalized.rules = normalizeRules(config.rules, details)
  }

  if (details.length) {
    throw buildError(details)
  }
  return normalized
}

module.exports = {
  validateConfig,
}
